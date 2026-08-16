import { FeedResponseSchema, type Env, type FeedItem } from './schema';

const FEED_URL = 'https://asx.api.markitdigital.com/asx-research/1.0/markets/announcements';
const FILE_URL = 'https://asx.api.markitdigital.com/asx-research/1.0/file';

/**
 * The access token is a public key lifted from the ASX site's own JavaScript.
 * It can be rotated without notice, so a 401/403 gets its own error type: the
 * poller must alert loudly rather than fail silently and show an empty market.
 */
export class AsxAuthError extends Error {
  constructor(readonly status: number) {
    super(`ASX access token rejected (HTTP ${status}) — it has likely been rotated`);
    this.name = 'AsxAuthError';
  }
}

export class AsxError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'AsxError';
  }
}

function headers(env: Env): HeadersInit {
  return {
    // Identify the app rather than pretending to be a browser.
    'User-Agent': env.USER_AGENT,
    Accept: 'application/json',
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Exponential backoff on any non-200. Auth failures are not retried — the
 * token is wrong and hammering the source will not fix it.
 */
async function fetchWithBackoff(
  url: string,
  init: RequestInit,
  attempts = 3,
): Promise<Response> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(2 ** attempt * 250);

    const res = await fetch(url, init);
    if (res.ok) return res;

    lastStatus = res.status;
    if (res.status === 401 || res.status === 403) throw new AsxAuthError(res.status);
    // 4xx other than auth/rate-limit is a request bug; retrying won't help.
    if (res.status < 500 && res.status !== 429) {
      throw new AsxError(res.status, `ASX returned HTTP ${res.status} for ${url}`);
    }
  }
  throw new AsxError(lastStatus, `ASX returned HTTP ${lastStatus} after ${attempts} attempts`);
}

export async function fetchFeed(env: Env, count = 50): Promise<FeedItem[]> {
  const res = await fetchWithBackoff(`${FEED_URL}?count=${count}`, { headers: headers(env) });
  const parsed = FeedResponseSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new AsxError(200, `Feed payload did not match the expected shape: ${parsed.error.message}`);
  }
  return parsed.data.data.items;
}

/**
 * The feed reports size as a string with a unit — "102KB", "3169KB" — despite
 * the field name suggesting a number. Returns whole KB, or null when the value
 * is missing or unparseable, since a wrong size is worse than no size.
 */
export function parseFileSizeKb(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.round(raw) : null;
  if (typeof raw !== 'string') return null;

  const match = /^\s*([\d,]*\.?\d+)\s*(B|KB|MB|GB)?\s*$/i.exec(raw);
  if (!match?.[1]) return null;

  const value = Number.parseFloat(match[1].replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;

  switch ((match[2] ?? 'KB').toUpperCase()) {
    case 'B':
      return Math.round(value / 1024);
    case 'MB':
      return Math.round(value * 1024);
    case 'GB':
      return Math.round(value * 1024 * 1024);
    default:
      return Math.round(value);
  }
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/**
 * The PDF header must appear within the first 1024 bytes (some files carry a
 * short preamble), so scan rather than checking offset 0.
 *
 * This exists because an upstream that is having a bad day does not return an
 * error — it returns a login page, a rate-limit notice, or a bot challenge,
 * with HTTP 200. Storing that in R2 under an immutable cache header poisons the
 * document permanently: every later request is a cache hit on garbage, and the
 * PDF viewer reports only "Failed to load PDF document".
 */
export function looksLikePdf(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer.slice(0, 1024));
  outer: for (let i = 0; i + PDF_MAGIC.length <= bytes.length; i++) {
    for (let j = 0; j < PDF_MAGIC.length; j++) {
      if (bytes[i + j] !== PDF_MAGIC[j]) continue outer;
    }
    return true;
  }
  return false;
}

export function r2KeyFor(documentKey: string): string {
  return `pdf/${documentKey}.pdf`;
}

export interface PdfResult {
  body: ArrayBuffer;
  /** True when this call went to the origin rather than R2. */
  fetched: boolean;
}

/**
 * R2 first, then origin, storing to R2 on miss. Never fetch the same PDF
 * twice — this is both politeness to the source and the thing that keeps the
 * PDF proxy fast enough to embed inline.
 */
export async function getPdf(env: Env, documentKey: string): Promise<PdfResult> {
  const key = r2KeyFor(documentKey);

  const cached = await env.PDFS.get(key);
  if (cached) {
    const body = await cached.arrayBuffer();
    if (!looksLikePdf(body)) {
      // Poisoned entry from before the write-side guard existed, or uploaded
      // by hand. Fail loudly with the remedy rather than serving junk forever.
      throw new AsxError(
        200,
        `Cached object ${key} is not a PDF (${body.byteLength} bytes). Remove it with ` +
          `\`wrangler r2 object delete asx-pdfs/${key} --remote\` and let it re-fetch.`,
      );
    }
    return { body, fetched: false };
  }

  const url = `${FILE_URL}/${encodeURIComponent(documentKey)}?access_token=${encodeURIComponent(
    env.ASX_ACCESS_TOKEN,
  )}`;
  const res = await fetchWithBackoff(url, {
    headers: { 'User-Agent': env.USER_AGENT, Accept: 'application/pdf' },
  });

  const body = await res.arrayBuffer();

  // Never cache something that is not a PDF. A bot challenge or an error page
  // arrives with HTTP 200 and would otherwise be stored under an immutable
  // cache header — wrong forever, with no way to tell from the symptom.
  if (!looksLikePdf(body)) {
    throw new AsxError(
      200,
      `Origin returned ${body.byteLength} bytes that are not a PDF for ${documentKey} — ` +
        `likely an error page or bot challenge. Not cached.`,
    );
  }

  await env.PDFS.put(key, body, {
    httpMetadata: { contentType: 'application/pdf' },
  });
  await env.DB.prepare('UPDATE announcements SET pdf_r2_key = ? WHERE document_key = ?')
    .bind(key, documentKey)
    .run();

  return { body, fetched: true };
}

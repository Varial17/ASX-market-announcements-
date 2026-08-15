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
    return { body: await cached.arrayBuffer(), fetched: false };
  }

  const url = `${FILE_URL}/${encodeURIComponent(documentKey)}?access_token=${encodeURIComponent(
    env.ASX_ACCESS_TOKEN,
  )}`;
  const res = await fetchWithBackoff(url, {
    headers: { 'User-Agent': env.USER_AGENT, Accept: 'application/pdf' },
  });

  const body = await res.arrayBuffer();
  await env.PDFS.put(key, body, {
    httpMetadata: { contentType: 'application/pdf' },
  });
  await env.DB.prepare('UPDATE announcements SET pdf_r2_key = ? WHERE document_key = ?')
    .bind(key, documentKey)
    .run();

  return { body, fetched: true };
}

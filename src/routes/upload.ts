import { looksLikePdf, r2KeyFor } from '../lib/asx';
import { classify } from '../lib/rules';
import { json } from '../lib/db';
import { MAX_PDF_BYTES } from '../lib/anthropic';
import type { Env } from '../lib/schema';

/**
 * Constant-time compare, so the endpoint does not leak the token one byte at a
 * time to anyone willing to measure.
 */
function tokenMatches(supplied: string, expected: string): boolean {
  if (supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < supplied.length; i++) {
    diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * PUT /api/pdf/:document_key
 *
 * Put a PDF straight into R2 for a document the poller cannot reach — a test
 * fixture, or a source that sits behind bot protection.
 *
 * This is a write endpoint on a public URL, so it is **disabled unless
 * UPLOAD_TOKEN is set**. Off by default rather than open by default: an
 * unauthenticated version would let anyone overwrite any document in the
 * bucket, and the R2 copy is what the analysis reads.
 */
export async function handleUpload(
  request: Request,
  env: Env,
  documentKey: string,
): Promise<Response> {
  if (!env.UPLOAD_TOKEN) {
    return json(
      {
        error: 'upload_disabled',
        message:
          'Set an UPLOAD_TOKEN secret to enable uploads: `wrangler secret put UPLOAD_TOKEN`.',
      },
      { status: 503 },
    );
  }

  const supplied = request.headers.get('X-Upload-Token') ?? '';
  if (!tokenMatches(supplied, env.UPLOAD_TOKEN)) {
    return json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await request.arrayBuffer();

  if (body.byteLength === 0) {
    return json({ error: 'empty_body' }, { status: 400 });
  }
  if (body.byteLength > MAX_PDF_BYTES) {
    return json(
      {
        error: 'too_large',
        message: `${(body.byteLength / 1024 / 1024).toFixed(1)}MB exceeds the ${
          MAX_PDF_BYTES / 1024 / 1024
        }MB analysis limit.`,
      },
      { status: 413 },
    );
  }
  // The same guard as the origin path: a bot challenge or an error page is
  // never written to the bucket.
  if (!looksLikePdf(body)) {
    return json(
      {
        error: 'not_a_pdf',
        message:
          'That file does not start with a %PDF- header. If it came from a site behind bot protection, save it from the browser rather than curl.',
      },
      { status: 415 },
    );
  }

  const key = r2KeyFor(documentKey);
  await env.PDFS.put(key, body, { httpMetadata: { contentType: 'application/pdf' } });

  const existing = await env.DB.prepare(
    'SELECT document_key FROM announcements WHERE document_key = ?',
  )
    .bind(documentKey)
    .first<{ document_key: string }>();

  if (existing) {
    await env.DB.prepare('UPDATE announcements SET pdf_r2_key = ? WHERE document_key = ?')
      .bind(key, documentKey)
      .run();
  } else {
    // Optional: create the feed row in the same call, so a one-off document can
    // be dropped in and tested without hand-writing SQL.
    const url = new URL(request.url);
    const symbol = url.searchParams.get('symbol');
    const headline = url.searchParams.get('headline');
    if (!symbol || !headline) {
      return json(
        {
          error: 'no_announcement',
          message:
            'No announcement row for this key. Pass ?symbol=CODE&headline=... to create one alongside the upload.',
        },
        { status: 404 },
      );
    }

    const type = url.searchParams.get('type') ?? 'Other';
    const priceSensitive = url.searchParams.get('price_sensitive') === 'true';
    const verdict = classify([type], headline, priceSensitive);
    const now = new Date().toISOString();

    await env.DB.prepare(
      `INSERT INTO announcements (
         document_key, symbol, company_name, headline, announcement_type, types_json,
         lodged_at, is_price_sensitive, file_size_kb, pdf_r2_key, first_seen_at,
         rule_floor, rule_ceiling, rule_flags_json
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        documentKey,
        symbol.toUpperCase(),
        url.searchParams.get('company') ?? symbol.toUpperCase(),
        headline,
        type,
        JSON.stringify([type]),
        url.searchParams.get('lodged_at') ?? now,
        priceSensitive ? 1 : 0,
        Math.round(body.byteLength / 1024),
        key,
        now,
        verdict.floor,
        verdict.ceiling,
        JSON.stringify(verdict.flags),
      )
      .run();
  }

  console.log(
    JSON.stringify({ event: 'pdf_uploaded', documentKey, bytes: body.byteLength }),
  );

  return json({
    ok: true,
    documentKey,
    key,
    bytes: body.byteLength,
    created: !existing,
  });
}

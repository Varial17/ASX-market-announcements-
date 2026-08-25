import { getPdf } from '../lib/asx';
import { json } from '../lib/db';
import type { Env } from '../lib/schema';

/**
 * GET /api/pdf/:document_key
 *
 * Same-origin proxy in front of R2. This route exists so the PDF frames
 * correctly in the detail pane — a cross-origin PDF will not.
 */
export async function handlePdf(
  request: Request,
  env: Env,
  documentKey: string,
): Promise<Response> {
  try {
    const { body, fetched } = await getPdf(env, documentKey);

    return new Response(body, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(body.byteLength),
        // The document never changes, but our ability to serve it has proven
        // fallible — a year of `immutable` meant one bad response was pinned in
        // the browser with no way to clear it. An hour keeps it cheap and lets
        // a fixed document heal itself.
        'Cache-Control': 'public, max-age=3600',
        'Content-Disposition': `inline; filename="${documentKey}.pdf"`,
        'X-Pdf-Source': fetched ? 'origin' : 'r2',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: 'pdf_proxy_failed', documentKey, message }));

    // This route is loaded in an iframe. A JSON body renders as a bare
    // "Failed to load PDF document" with no clue why, so browsers get a page
    // that actually says what broke.
    if (request.headers.get('Accept')?.includes('text/html')) {
      const escape = (s: string): string =>
        s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>Document unavailable</title>` +
          `<style>body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:28px;` +
          `color:#14181f;background:#f6f7f9}` +
          `@media(prefers-color-scheme:dark){body{color:#e6eaf0;background:#171c24}}` +
          `code{font-family:ui-monospace,monospace;font-size:12.5px;word-break:break-all}` +
          `h1{font-size:15px;margin:0 0 8px}p{margin:0 0 10px;max-width:60ch}</style>` +
          `<h1>Source document unavailable</h1>` +
          `<p>${escape(message)}</p>` +
          `<p><code>${escape(documentKey)}</code></p>`,
        { status: 502, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
      );
    }
    return json({ error: 'pdf_unavailable', message }, { status: 502 });
  }
}

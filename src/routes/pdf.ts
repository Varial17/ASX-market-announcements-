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
  _request: Request,
  env: Env,
  documentKey: string,
): Promise<Response> {
  try {
    const { body, fetched } = await getPdf(env, documentKey);

    return new Response(body, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(body.byteLength),
        // A lodged announcement never changes.
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Disposition': `inline; filename="${documentKey}.pdf"`,
        'X-Pdf-Source': fetched ? 'origin' : 'r2',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: 'pdf_proxy_failed', documentKey, message }));
    return json({ error: 'pdf_unavailable', message }, { status: 502 });
  }
}

import { json, toAnalysis, toFeedItem, type AnalysisRow, type AnnouncementRow } from '../lib/db';
import type { Env } from '../lib/schema';

/** GET /api/announcements/:document_key */
export async function handleDetail(
  _request: Request,
  env: Env,
  documentKey: string,
): Promise<Response> {
  const announcement = await env.DB.prepare(
    'SELECT * FROM announcements WHERE document_key = ?',
  )
    .bind(documentKey)
    .first<AnnouncementRow>();

  if (!announcement) {
    return json({ error: 'not_found', documentKey }, { status: 404 });
  }

  const analysis = await env.DB.prepare('SELECT * FROM analyses WHERE document_key = ?')
    .bind(documentKey)
    .first<AnalysisRow>();

  return json({
    announcement: toFeedItem({
      ...announcement,
      materiality: analysis?.materiality,
      direction: analysis?.direction,
      category: analysis?.category,
    }),
    analysis: analysis ? toAnalysis(analysis) : null,
    pdfUrl: `/api/pdf/${encodeURIComponent(documentKey)}`,
  });
}

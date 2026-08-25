import { json, toFeedItem, type FeedRow } from '../lib/db';
import type { Env } from '../lib/schema';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

/**
 * GET /api/announcements
 *   ?limit=   1..200, default 100
 *   ?filter=  all | price_sensitive | analysed | test
 *   ?q=       substring over code, company, headline
 *   ?before=  ISO timestamp cursor, exclusive (keyset pagination)
 */
export async function handleFeed(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(url.searchParams.get('limit')) || DEFAULT_LIMIT),
  );
  const filter = url.searchParams.get('filter') ?? 'all';
  const q = (url.searchParams.get('q') ?? '').trim();
  const before = url.searchParams.get('before');

  const where: string[] = [];
  const binds: unknown[] = [];

  if (filter === 'price_sensitive') where.push('a.is_price_sensitive = 1');
  if (filter === 'analysed') where.push('an.document_key IS NOT NULL');
  // Manually uploaded documents — test fixtures, and sources the poller cannot
  // reach. Kept in the default view too; this tab just makes them findable.
  if (filter === 'test') where.push("a.source = 'upload'");

  if (q) {
    // Bound three times rather than once as ?1: all-positional placeholders
    // keep the bind list trivially in step with the SQL as clauses come and go.
    where.push('(a.symbol LIKE ? OR a.company_name LIKE ? OR a.headline LIKE ?)');
    binds.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (before) {
    where.push('a.lodged_at < ?');
    binds.push(before);
  }

  const sql = `
    SELECT a.*, an.materiality, an.direction, an.category, an.generated_at
    FROM announcements a
    LEFT JOIN analyses an ON an.document_key = a.document_key
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY a.lodged_at DESC
    LIMIT ?
  `;

  const { results } = await env.DB.prepare(sql)
    .bind(...binds, limit)
    .all<FeedRow>();

  const lastIngest = await env.DB.prepare(
    'SELECT ran_at FROM ingest_runs WHERE error IS NULL ORDER BY ran_at DESC LIMIT 1',
  ).first<{ ran_at: string }>();

  const items = results.map(toFeedItem);

  return json({
    items,
    nextBefore: items.length === limit ? items[items.length - 1]?.lodgedAt ?? null : null,
    lastIngestAt: lastIngest?.ran_at ?? null,
    serverTime: new Date().toISOString(),
  });
}

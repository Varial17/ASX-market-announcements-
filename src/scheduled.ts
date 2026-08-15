import { AsxAuthError, fetchFeed } from './lib/asx';
import { classify } from './lib/rules';
import { buildHealth } from './routes/health';
import { isMarketWindow } from './lib/time';
import type { Env, FeedItem } from './lib/schema';

/** The cron pattern that runs the staleness watchdog; everything else polls. */
export const WATCHDOG_CRON = '0 * * * *';

interface Prepared {
  documentKey: string;
  binds: unknown[];
}

const INSERT_SQL = `
  INSERT OR IGNORE INTO announcements (
    document_key, symbol, company_name, headline, announcement_type, types_json,
    lodged_at, is_price_sensitive, file_size_kb, isin, sector, industry,
    first_seen_at, rule_floor, rule_ceiling, rule_flags_json
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`;

function prepareItem(item: FeedItem, seenAt: string): Prepared | null {
  if (!item.documentKey) return null;

  const info = item.companyInfo?.[0];
  const types = item.announcementTypes?.filter((t) => typeof t === 'string' && t.length > 0) ?? [];
  const isPriceSensitive = item.isPriceSensitive === true;
  const headline = item.headline ?? '';

  // Normalise to ISO 8601 UTC. The feed's `date` is already UTC; parsing and
  // re-serialising guarantees a single comparable format in the column that
  // every query sorts on.
  const parsedDate = new Date(item.date);
  if (Number.isNaN(parsedDate.getTime())) return null;

  const verdict = classify(types, headline, isPriceSensitive);

  return {
    documentKey: item.documentKey,
    binds: [
      item.documentKey,
      item.symbol,
      info?.displayName ?? item.symbol,
      headline,
      // Element 0 is the primary type; the whole array is kept as JSON.
      types[0] ?? 'Unknown',
      JSON.stringify(types),
      parsedDate.toISOString(),
      isPriceSensitive ? 1 : 0,
      item.fileSize ?? null,
      info?.isin ?? null,
      item.sector ?? null,
      item.industry ?? null,
      seenAt,
      verdict.floor,
      verdict.ceiling,
      JSON.stringify(verdict.flags),
    ],
  };
}

async function recordRun(
  env: Env,
  ranAt: string,
  fetched: number,
  inserted: number,
  error: string | null,
): Promise<void> {
  await env.DB.prepare('INSERT INTO ingest_runs (ran_at, fetched, inserted, error) VALUES (?,?,?,?)')
    .bind(ranAt, fetched, inserted, error)
    .run();
}

/**
 * The poller. Never throws: a thrown cron handler is retried by the platform,
 * which would hammer the source.
 */
export async function poll(env: Env, now = new Date()): Promise<void> {
  // Silent outside 07:00-20:00 Australia/Sydney, Mon-Fri. No request, no
  // ingest_runs row — an empty overnight is not a failure to alert on.
  if (!isMarketWindow(now)) return;

  const ranAt = now.toISOString();

  try {
    const items = await fetchFeed(env, 50);
    const statements = items
      .map((item) => prepareItem(item, ranAt))
      .filter((p): p is Prepared => p !== null)
      .map((p) => env.DB.prepare(INSERT_SQL).bind(...p.binds));

    let inserted = 0;
    if (statements.length > 0) {
      // document_key is the primary key, so INSERT OR IGNORE is the dedupe.
      // No SELECT-then-INSERT.
      const results = await env.DB.batch(statements);
      inserted = results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
    }

    await recordRun(env, ranAt, items.length, inserted, null);

    if (inserted > 0) {
      console.log(JSON.stringify({ event: 'ingest', fetched: items.length, inserted }));
    }
  } catch (err) {
    const message =
      err instanceof AsxAuthError
        ? `${err.message} — set a fresh ASX_ACCESS_TOKEN with \`wrangler secret put ASX_ACCESS_TOKEN\``
        : err instanceof Error
          ? err.message
          : String(err);

    console.error(JSON.stringify({ event: 'ingest_failed', message }));
    try {
      await recordRun(env, ranAt, 0, 0, message);
    } catch (dbErr) {
      // If D1 itself is down there is nowhere left to record this. Log and
      // return — still do not throw.
      console.error(
        JSON.stringify({
          event: 'ingest_run_unrecordable',
          message: dbErr instanceof Error ? dbErr.message : String(dbErr),
        }),
      );
    }
  }
}

async function sendAlert(env: Env, text: string, report: unknown): Promise<void> {
  if (!env.ALERT_WEBHOOK_URL) {
    console.error(JSON.stringify({ event: 'alert_undelivered', reason: 'no_webhook', text }));
    return;
  }
  try {
    await fetch(env.ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `text` is the field Slack and Discord both render, so a raw incoming
      // webhook URL works with no adapter.
      body: JSON.stringify({ text, report }),
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'alert_failed',
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/** Hourly, market hours only: has ingestion silently stopped? */
export async function watchdog(env: Env, now = new Date()): Promise<void> {
  if (!isMarketWindow(now)) return;

  const report = await buildHealth(env, now);
  if (!report.stale) return;

  const age = report.ageSeconds === null ? 'never' : `${Math.round(report.ageSeconds / 60)}m ago`;
  await sendAlert(
    env,
    `ASX screener: no successful ingest in over 15 minutes during market hours (last: ${age}). ` +
      `Errors in the last hour: ${report.errorsLastHour}. Last error: ${report.lastError ?? 'none'}`,
    report,
  );
}

export async function handleScheduled(
  event: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  if (event.cron === WATCHDOG_CRON) {
    await watchdog(env);
    return;
  }
  await poll(env);
}

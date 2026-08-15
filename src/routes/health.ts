import { json } from '../lib/db';
import { isMarketWindow } from '../lib/time';
import type { Env } from '../lib/schema';

/**
 * Silent ingest failure is the bug that kills this product: if the poller
 * stops at 10am and nobody notices until Friday, the site has been confidently
 * showing an empty market for four days.
 */
export const STALE_AFTER_MS = 15 * 60 * 1000;

export interface HealthReport {
  ok: boolean;
  now: string;
  marketOpen: boolean;
  lastSuccessfulIngestAt: string | null;
  ageSeconds: number | null;
  stale: boolean;
  runsLastHour: number;
  errorsLastHour: number;
  lastError: string | null;
  announcements: number;
  analyses: number;
}

export async function buildHealth(env: Env, now = new Date()): Promise<HealthReport> {
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

  const [lastOk, lastHour, lastErr, counts] = await Promise.all([
    env.DB.prepare(
      'SELECT ran_at FROM ingest_runs WHERE error IS NULL ORDER BY ran_at DESC LIMIT 1',
    ).first<{ ran_at: string }>(),
    env.DB.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors
       FROM ingest_runs WHERE ran_at >= ?`,
    )
      .bind(hourAgo)
      .first<{ total: number; errors: number | null }>(),
    env.DB.prepare(
      'SELECT error FROM ingest_runs WHERE error IS NOT NULL ORDER BY ran_at DESC LIMIT 1',
    ).first<{ error: string }>(),
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM announcements) AS announcements,
         (SELECT COUNT(*) FROM analyses) AS analyses`,
    ).first<{ announcements: number; analyses: number }>(),
  ]);

  const marketOpen = isMarketWindow(now);
  const ageMs = lastOk ? now.getTime() - new Date(lastOk.ran_at).getTime() : null;
  // Outside market hours there is nothing to be stale about — the poller is
  // supposed to be silent.
  const stale = marketOpen && (ageMs === null || ageMs > STALE_AFTER_MS);

  return {
    ok: !stale,
    now: now.toISOString(),
    marketOpen,
    lastSuccessfulIngestAt: lastOk?.ran_at ?? null,
    ageSeconds: ageMs === null ? null : Math.round(ageMs / 1000),
    stale,
    runsLastHour: lastHour?.total ?? 0,
    errorsLastHour: lastHour?.errors ?? 0,
    lastError: lastErr?.error ?? null,
    announcements: counts?.announcements ?? 0,
    analyses: counts?.analyses ?? 0,
  };
}

/** GET /api/health */
export async function handleHealth(_request: Request, env: Env): Promise<Response> {
  const report = await buildHealth(env);
  return json(report, { status: report.ok ? 200 : 503 });
}

import { z } from 'zod';

export interface Env {
  DB: D1Database;
  PDFS: R2Bucket;

  // Secrets — `wrangler secret put <NAME>`
  ANTHROPIC_API_KEY: string;
  ASX_ACCESS_TOKEN: string;
  /** Optional. If unset, the staleness watchdog logs instead of alerting. */
  ALERT_WEBHOOK_URL?: string;
  /** Optional. If unset, PUT /api/pdf/:key is disabled — off by default. */
  UPLOAD_TOKEN?: string;

  // Vars — wrangler.toml
  ANALYSIS_MODEL: string;
  ANALYSIS_EFFORT: string;
  USER_AGENT: string;
  /** Comma or space separated tickers requiring additional review. May be empty. */
  WATCHLIST_TICKERS?: string;
}

/**
 * The private JSON API behind asx.com.au. Only the fields we actually read are
 * declared; `.passthrough()` is deliberate so an upstream addition is ignored
 * rather than fatal.
 *
 * Only the fields we read are declared. Unknown keys are stripped rather than
 * rejected, so an upstream addition is a non-event.
 *
 * Gotchas encoded here:
 *  - `url` is always empty. We build the PDF link from documentKey ourselves.
 *  - `date` is UTC. Never store local time.
 *  - `fileSize` is a STRING like "102KB" or "3169KB" — not a number. Verified
 *    against the live feed on 2026-08-16; the build brief said number, and a
 *    z.number() here rejects every item and stops ingestion dead.
 *  - `sector`/`industry` live inside companyInfo[0], NOT at the top level.
 *  - `companyInfo` can be an empty array (e.g. "End of Day" notices), so the
 *    company name falls back to the symbol.
 *  - `announcementTypes` is an array and frequently has several entries.
 *  - `documentKey` is the only stable unique ID.
 */
export const CompanyInfoSchema = z.object({
  symbol: z.string().optional(),
  displayName: z.string().optional(),
  issueType: z.string().optional(),
  isin: z.string().optional(),
  xid: z.string().optional(),
  sector: z.string().nullish(),
  industryGroup: z.string().nullish(),
  industry: z.string().nullish(),
  subIndustry: z.string().nullish(),
});

export const FeedItemSchema = z.object({
  symbol: z.string(),
  documentKey: z.string().min(1),
  headline: z.string(),
  date: z.string(),
  companyInfo: z.array(CompanyInfoSchema).optional(),
  announcementTypes: z.array(z.string()).optional(),
  // Union, not z.number(): the live feed sends "102KB". Accepting both means a
  // future change back to a number is not an outage.
  fileSize: z.union([z.number(), z.string()]).nullish(),
  isPriceSensitive: z.boolean().optional(),
  sector: z.string().nullish(),
  industryGroup: z.string().nullish(),
  industry: z.string().nullish(),
  subIndustry: z.string().nullish(),
});

export const FeedResponseSchema = z.object({
  data: z.object({
    items: z.array(FeedItemSchema),
  }),
});

export type FeedItem = z.infer<typeof FeedItemSchema>;

export const CheckStatusSchema = z.enum(['pass', 'query', 'fail', 'not_assessable']);

export const ComplianceCheckSchema = z.object({
  status: CheckStatusSchema,
  note: z.string(),
  evidence: z.string().optional(),
});

/**
 * Every check is required. A missing key means the model skipped a box, which
 * must fail validation rather than render as a silent gap in the checklist.
 */
export const ComplianceSchema = z.object({
  overall: z.enum(['clear', 'query', 'reject']),
  checks: z.object({
    title: ComplianceCheckSchema,
    entity: ComplianceCheckSchema,
    price_sensitivity: ComplianceCheckSchema,
    watch_list: ComplianceCheckSchema,
    inappropriate_content: ComplianceCheckSchema,
    format: ComplianceCheckSchema,
    category: ComplianceCheckSchema,
    draft_or_deformity: ComplianceCheckSchema,
    dates_and_numbers: ComplianceCheckSchema,
    completeness: ComplianceCheckSchema,
  }),
});

export type Compliance = z.infer<typeof ComplianceSchema>;

/** Matches the `record_analysis` tool schema in src/lib/anthropic.ts. */
export const AnalysisSchema = z.object({
  category: z.enum([
    'capital_raising',
    'capital_structure',
    'earnings_guidance',
    'results',
    'ownership',
    'governance',
    'insider_activity',
    'operations',
    'exploration',
    'corporate_action',
    'distribution',
    'compliance',
    'fund_reporting',
    'calendar',
    'other',
  ]),
  direction: z.enum(['positive', 'negative', 'neutral']),
  materiality: z.number().int().min(1).max(5),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  why_it_matters: z.string(),
  figures: z.array(z.object({ label: z.string(), value: z.string() })),
  parties: z.array(
    z.object({
      name: z.string(),
      role: z.string(),
      ticker: z.string().optional(),
    }),
  ),
  flags: z.array(z.string()),
  source_quote: z.string().optional(),
  compliance: ComplianceSchema,
});

export type Analysis = z.infer<typeof AnalysisSchema>;

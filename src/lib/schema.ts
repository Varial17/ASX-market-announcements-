import { z } from 'zod';

export interface Env {
  DB: D1Database;
  PDFS: R2Bucket;

  // Secrets — `wrangler secret put <NAME>`
  ANTHROPIC_API_KEY: string;
  ASX_ACCESS_TOKEN: string;
  /** Optional. If unset, the staleness watchdog logs instead of alerting. */
  ALERT_WEBHOOK_URL?: string;

  // Vars — wrangler.toml
  ANALYSIS_MODEL: string;
  ANALYSIS_EFFORT: string;
  USER_AGENT: string;
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
 *  - `fileSize` is a number in KB, not a string.
 *  - `announcementTypes` is an array and frequently has several entries.
 *  - `documentKey` is the only stable unique ID.
 */
export const CompanyInfoSchema = z.object({
  symbol: z.string().optional(),
  displayName: z.string().optional(),
  issueType: z.string().optional(),
  isin: z.string().optional(),
  xid: z.string().optional(),
});

export const FeedItemSchema = z.object({
  symbol: z.string(),
  documentKey: z.string().min(1),
  headline: z.string(),
  date: z.string(),
  companyInfo: z.array(CompanyInfoSchema).optional(),
  announcementTypes: z.array(z.string()).optional(),
  fileSize: z.number().nullish(),
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
  flags: z.array(z.string()),
  source_quote: z.string().optional(),
});

export type Analysis = z.infer<typeof AnalysisSchema>;

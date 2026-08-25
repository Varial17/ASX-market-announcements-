import type { Analysis } from './schema';

export interface AnnouncementRow {
  document_key: string;
  symbol: string;
  company_name: string;
  headline: string;
  announcement_type: string;
  types_json: string;
  lodged_at: string;
  is_price_sensitive: number;
  file_size_kb: number | null;
  isin: string | null;
  sector: string | null;
  industry: string | null;
  pdf_r2_key: string | null;
  first_seen_at: string;
  rule_floor: number | null;
  rule_ceiling: number | null;
  rule_flags_json: string | null;
  /** 'asx' from the poller, 'upload' from PUT /api/pdf/:key. */
  source: string | null;
}

export interface AnalysisRow {
  document_key: string;
  category: string;
  direction: string;
  materiality: number;
  confidence: number;
  summary: string;
  why_it_matters: string;
  figures_json: string;
  flags_json: string;
  source_quote: string | null;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  generated_at: string;
  /** Null for rows written before migration 0002. */
  compliance_overall: string | null;
  compliance_json: string | null;
  /** Null for rows written before migration 0003. */
  parties_json: string | null;
}

/** A feed row joined to its analysis, so the list can annotate itself. */
export type FeedRow = AnnouncementRow &
  Partial<Pick<AnalysisRow, 'materiality' | 'direction' | 'category' | 'generated_at'>>;

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function toFeedItem(row: FeedRow) {
  return {
    documentKey: row.document_key,
    symbol: row.symbol,
    companyName: row.company_name,
    headline: row.headline,
    type: row.announcement_type,
    types: parseJsonArray(row.types_json),
    lodgedAt: row.lodged_at,
    isPriceSensitive: row.is_price_sensitive === 1,
    fileSizeKb: row.file_size_kb,
    sector: row.sector,
    industry: row.industry,
    ruleFlags: parseJsonArray(row.rule_flags_json),
    source: row.source ?? 'asx',
    isTest: row.source === 'upload',
    analysed: row.materiality != null,
    materiality: row.materiality ?? null,
    direction: row.direction ?? null,
    category: row.category ?? null,
  };
}

export function toAnalysis(row: AnalysisRow) {
  let figures: Array<{ label: string; value: string }> = [];
  try {
    const parsed: unknown = JSON.parse(row.figures_json);
    if (Array.isArray(parsed)) figures = parsed as Array<{ label: string; value: string }>;
  } catch {
    figures = [];
  }
  return {
    category: row.category,
    direction: row.direction,
    materiality: row.materiality,
    confidence: row.confidence,
    summary: row.summary,
    whyItMatters: row.why_it_matters,
    figures,
    flags: parseJsonArray(row.flags_json),
    sourceQuote: row.source_quote,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    generatedAt: row.generated_at,
    // Null for analyses generated before the checklist existed. The UI shows a
    // "re-run to add the checklist" prompt rather than an empty one.
    compliance: parseCompliance(row.compliance_json),
    parties: parseParties(row.parties_json),
  };
}

function parseParties(raw: string | null): Array<{ name: string; role: string; ticker?: string }> {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Array<{ name: string; role: string }>) : [];
  } catch {
    return [];
  }
}

function parseCompliance(raw: string | null): unknown | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * INSERT OR REPLACE, not a lock. Two users clicking Generate at the same
 * moment occasionally costs 2c of duplicated work; locking costs more than
 * that in complexity.
 */
export async function saveAnalysis(
  db: D1Database,
  documentKey: string,
  analysis: Analysis,
  meta: { model: string; inputTokens: number | null; outputTokens: number | null },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO analyses (
         document_key, category, direction, materiality, confidence, summary,
         why_it_matters, figures_json, flags_json, source_quote, model,
         input_tokens, output_tokens, generated_at,
         compliance_overall, compliance_json, parties_json
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      documentKey,
      analysis.category,
      analysis.direction,
      analysis.materiality,
      analysis.confidence,
      analysis.summary,
      analysis.why_it_matters,
      JSON.stringify(analysis.figures),
      JSON.stringify(analysis.flags),
      analysis.source_quote ?? null,
      meta.model,
      meta.inputTokens,
      meta.outputTokens,
      new Date().toISOString(),
      analysis.compliance.overall,
      JSON.stringify(analysis.compliance),
      JSON.stringify(analysis.parties),
    )
    .run();
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(init.headers ?? {}),
    },
  });
}

/**
 * The ASX announcement review checklist.
 *
 * Defined once here and used three ways: to build the tool schema sent to the
 * model, to validate what comes back, and to label the UI. Adding a check means
 * editing this object and nothing else.
 */
export const COMPLIANCE_CHECKS = {
  title:
    'Title is clear and accurate, is not misleading, and appropriately describes the content for investors.',
  entity:
    'The entity named in the document matches the ticker and company on the lodgement, and the document carries an authorisation-for-release statement (board, company secretary or named authorised officer).',
  price_sensitivity:
    "The issuer's own price-sensitive flag is consistent with the content of the document.",
  watch_list:
    'Whether the entity appears on the configured regulatory watch list requiring additional review.',
  inappropriate_content:
    'No profanity, offensive language, or content that is inappropriate in context.',
  format:
    'Correct format for this announcement type, using the exchange-prescribed form where one applies (e.g. Appendix 2A, 3H, 3Y).',
  category:
    'The announcement type recorded on lodgement matches what the document actually contains.',
  draft_or_deformity:
    'No draft watermarks, placeholder or template text, missing or blank pages, truncation, corruption or rendering defects.',
  dates_and_numbers:
    'Dates and figures are internally consistent, current, and plausible — no stale periods, contradictory totals or impossible dates.',
  completeness:
    'Critical information for this announcement type is present. For example, an acquisition must state the purchase price and the funding method.',
} as const;

export type ComplianceCheckId = keyof typeof COMPLIANCE_CHECKS;

export const COMPLIANCE_CHECK_IDS = Object.keys(COMPLIANCE_CHECKS) as ComplianceCheckId[];

/** Human-facing labels, in checklist order. */
export const COMPLIANCE_LABELS: Record<ComplianceCheckId, string> = {
  title: 'Title',
  entity: 'Entity & authorisation',
  price_sensitivity: 'Price sensitivity',
  watch_list: 'Watch list',
  inappropriate_content: 'Inappropriate content',
  format: 'Format',
  category: 'Category',
  draft_or_deformity: 'Draft marks / deformity',
  dates_and_numbers: 'Dates & numbers',
  completeness: 'Completeness',
};

export type CheckStatus = 'pass' | 'query' | 'fail' | 'not_assessable';

/**
 * The watch list is deterministic input, not a model judgement — there is no
 * feed of "entities under regulatory scrutiny", and inviting the model to guess
 * would produce confident fiction in the one place it does most damage.
 * Configure via the WATCHLIST_TICKERS var in wrangler.toml.
 */
export function parseWatchlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(/[,\s]+/)
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean),
  );
}

export interface WatchlistVerdict {
  status: CheckStatus;
  note: string;
}

export function checkWatchlist(symbol: string, watchlist: Set<string>): WatchlistVerdict {
  if (watchlist.size === 0) {
    return {
      status: 'not_assessable',
      note: 'No watch list configured. Set WATCHLIST_TICKERS to enable this check — an empty list is reported as unassessed rather than as a pass.',
    };
  }
  if (watchlist.has(symbol.toUpperCase())) {
    return {
      status: 'query',
      note: `${symbol} is on the configured watch list. Refer for additional review.`,
    };
  }
  return { status: 'pass', note: `${symbol} is not on the configured watch list.` };
}

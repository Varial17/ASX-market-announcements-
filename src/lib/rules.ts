/**
 * Deterministic flagging. Runs at ingest, no model involved.
 *
 * Rules are for certainty, the model is for nuance: these set a materiality
 * floor and ceiling, and the AI refines *within* those bounds. It does not
 * override them.
 */

export interface RuleVerdict {
  /** Materiality can never be scored below this. */
  floor: number;
  /** Materiality can never be scored above this. */
  ceiling: number;
  flags: string[];
}

/**
 * Floor materiality 4 — flag immediately. Matched as a normalised substring
 * against every entry in `announcementTypes`, because ASX type strings carry
 * inconsistent suffixes ("Trading Halt", "Trading Halt - XYZ").
 */
const ALWAYS_MATERIAL: readonly string[] = [
  'trading halt',
  'suspension from official quotation',
  'suspension from quotation',
  'reinstatement to official quotation',
  'reinstatement to quotation',
  'takeover',
  'off-market bid',
  'off market bid',
  'scheme of arrangement',
  'becoming a substantial holder',
  'change in substantial holding',
  'change of substantial holding',
  'ceasing to be a substantial holder',
  'earnings guidance',
  'guidance issued',
  'guidance revised',
  'guidance withdrawn',
  'asx price query',
  'price query',
  'asx aware letter',
  'aware letter',
  'asic',
  'appointment of administrator',
  'appointment of receiver',
  'appointment of liquidator',
  'administrators appointed',
  'receivers appointed',
  'liquidator appointed',
];

/** Ceiling materiality 2 — never auto-alert. */
const ALWAYS_ROUTINE: readonly string[] = [
  'cleansing notice',
  'cleansing statement',
  'appendix 2a',
  'appendix 3h',
  'net tangible asset',
  'nta',
  'daily fund update',
  'daily net tangible',
  "change of director's interest notice",
  "initial director's interest notice",
  "final director's interest notice",
  'notice of meeting',
  'notice of annual general meeting',
  'proxy form',
  'results of meeting',
];

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’]/g, "'") // curly apostrophes in "Director's"
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Word-boundary matching, not `includes`. Plain substring matching is actively
 * dangerous for the short acronyms in these lists: "nta" appears inside
 * "prese-nta-tion" (would cap an investor presentation at materiality 2) and
 * "asic" appears inside "b-asic" (would floor "Basic Earnings Per Share" at 4).
 * Every needle here starts and ends with an alphanumeric, so \b is safe.
 */
function compile(needles: readonly string[]): RegExp[] {
  return needles.map(
    (needle) => new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
  );
}

const MATERIAL_PATTERNS = compile(ALWAYS_MATERIAL);
const ROUTINE_PATTERNS = compile(ALWAYS_ROUTINE);

function matches(haystacks: string[], patterns: readonly RegExp[]): boolean {
  return haystacks.some((raw) => {
    const hay = normalise(raw);
    return patterns.some((pattern) => pattern.test(hay));
  });
}

/**
 * `types` is the full `announcementTypes` array; `headline` is included in the
 * match surface because issuers routinely put the meaningful words there while
 * the type stays generic ("General Announcement").
 */
export function classify(
  types: string[],
  headline: string,
  isPriceSensitive: boolean,
): RuleVerdict {
  const surface = [...types, headline].filter(Boolean);
  const flags: string[] = [];

  let floor = 1;
  let ceiling = 5;

  if (matches(surface, ROUTINE_PATTERNS)) {
    ceiling = 2;
    flags.push('always_routine');
  }

  if (matches(surface, MATERIAL_PATTERNS)) {
    floor = 4;
    flags.push('always_material');
  }

  // The issuer's own price-sensitive flag is a hard signal: floor of 3
  // regardless of type.
  if (isPriceSensitive) {
    floor = Math.max(floor, 3);
    flags.push('price_sensitive');
  }

  // ALWAYS_MATERIAL and a price-sensitive flag both outrank the routine
  // ceiling — a price-sensitive "Results of Meeting" is not routine paperwork.
  // Raising the ceiling to the floor keeps the band non-empty rather than
  // silently inverting it.
  if (ceiling < floor) ceiling = floor;

  return { floor, ceiling, flags };
}

/** Clamp the model's materiality into the deterministic band. */
export function applyBounds(materiality: number, verdict: RuleVerdict): number {
  return Math.min(verdict.ceiling, Math.max(verdict.floor, materiality));
}

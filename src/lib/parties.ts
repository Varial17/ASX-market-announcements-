/**
 * Exchange-qualified ticker codes.
 *
 * A bare code is ambiguous across exchanges and that ambiguity is dangerous on
 * a compliance record: "TPG" is TPG Telecom on the ASX and the unrelated US
 * private equity firm on NASDAQ. A reader seeing "TPG" against an Infomedia
 * scheme could reasonably conclude the wrong company is the acquirer.
 */

/** EXCHANGE:CODE — e.g. ASX:IFM, NYSE:BRK.A, NASDAQ:TPG. */
const QUALIFIED = /^([A-Z]{2,6}):([A-Z0-9.\-]{1,12})$/;
const BARE_CODE = /^[A-Z0-9.\-]{1,12}$/;

export interface Party {
  name: string;
  role: string;
  ticker?: string;
}

/**
 * Returns a qualified ticker, or null when one cannot be established honestly.
 *
 * A bare code is only promoted to ASX: when it is the lodging entity's own
 * code, which we know from the announcement metadata. Any other bare code is
 * dropped rather than guessed at — showing no ticker is a small loss, showing
 * the wrong exchange is a wrong fact.
 */
export function normaliseTicker(raw: string | undefined, lodgingSymbol: string): string | null {
  if (!raw) return null;

  const cleaned = raw.toUpperCase().replace(/\s+/g, '');
  if (!cleaned) return null;

  const qualified = QUALIFIED.exec(cleaned);
  if (qualified) return `${qualified[1]}:${qualified[2]}`;

  if (BARE_CODE.test(cleaned)) {
    // The one case where the exchange is known structurally rather than guessed.
    if (cleaned === lodgingSymbol.toUpperCase()) return `ASX:${cleaned}`;
    return null;
  }

  return null;
}

export function normaliseParties(parties: Party[], lodgingSymbol: string): Party[] {
  return parties.map((party) => {
    const ticker = normaliseTicker(party.ticker, lodgingSymbol);
    return ticker ? { ...party, ticker } : { name: party.name, role: party.role };
  });
}

import { describe, expect, it } from 'vitest';
import { normaliseParties, normaliseTicker } from '../src/lib/parties';
import { SYSTEM_PROMPT } from '../src/lib/anthropic';

describe('normaliseTicker', () => {
  it('keeps an already-qualified code', () => {
    expect(normaliseTicker('ASX:IFM', 'IFM')).toBe('ASX:IFM');
    expect(normaliseTicker('NASDAQ:TPG', 'IFM')).toBe('NASDAQ:TPG');
    expect(normaliseTicker('NYSE:BRK.A', 'IFM')).toBe('NYSE:BRK.A');
  });

  it('tidies case and stray spacing', () => {
    expect(normaliseTicker('asx: ifm', 'IFM')).toBe('ASX:IFM');
    expect(normaliseTicker('  Nasdaq:tpg  ', 'IFM')).toBe('NASDAQ:TPG');
  });

  it('promotes a bare code only for the lodging entity, whose exchange we know', () => {
    expect(normaliseTicker('IFM', 'IFM')).toBe('ASX:IFM');
    expect(normaliseTicker('ifm', 'IFM')).toBe('ASX:IFM');
  });

  it('drops a bare code for anyone else rather than guessing the exchange', () => {
    // The case that motivated this: ASX:TPG is TPG Telecom, NASDAQ:TPG is the
    // US private equity firm. A bare "TPG" on an Infomedia scheme points the
    // reader at entirely the wrong company.
    expect(normaliseTicker('TPG', 'IFM')).toBeNull();
    expect(normaliseTicker('BHP', 'IFM')).toBeNull();
  });

  it('drops anything malformed', () => {
    expect(normaliseTicker(undefined, 'IFM')).toBeNull();
    expect(normaliseTicker('', 'IFM')).toBeNull();
    expect(normaliseTicker('not a ticker at all', 'IFM')).toBeNull();
    expect(normaliseTicker('TOOLONGEXCHANGE:ABC', 'IFM')).toBeNull();
  });
});

describe('normaliseParties', () => {
  it('qualifies what it can and strips what it cannot', () => {
    const out = normaliseParties(
      [
        { name: 'Infomedia Limited', role: 'target', ticker: 'IFM' },
        { name: 'TPG Global, LLC', role: 'acquirer', ticker: 'TPG' },
        { name: 'Yandal Investments Pty Ltd', role: 'substantial holder' },
      ],
      'IFM',
    );
    expect(out[0]?.ticker).toBe('ASX:IFM');
    expect(out[1]?.ticker).toBeUndefined();
    expect(out[1]?.name).toBe('TPG Global, LLC');
    expect(out[2]?.ticker).toBeUndefined();
  });
});

describe('prompt', () => {
  it('demands exchange-qualified tickers and explains the TPG collision', () => {
    expect(SYSTEM_PROMPT).toMatch(/exchange-qualified/i);
    expect(SYSTEM_PROMPT).toContain('NASDAQ:TPG');
    expect(SYSTEM_PROMPT).toMatch(/TPG Telecom on the ASX/);
  });
});

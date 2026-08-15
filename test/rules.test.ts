import { describe, expect, it } from 'vitest';
import { applyBounds, classify } from '../src/lib/rules';

describe('classify', () => {
  it('floors always-material types at 4', () => {
    const v = classify(['Trading Halt'], 'Trading Halt', false);
    expect(v.floor).toBe(4);
    expect(v.flags).toContain('always_material');
  });

  it('caps always-routine types at 2', () => {
    const v = classify(['Cleansing Notice'], 'Cleansing Notice - s708A', false);
    expect(v.ceiling).toBe(2);
    expect(v.floor).toBe(1);
    expect(v.flags).toContain('always_routine');
  });

  it('floors anything issuer-flagged price sensitive at 3', () => {
    const v = classify(['General Announcement'], 'Quarterly Activities Report', true);
    expect(v.floor).toBe(3);
    expect(v.flags).toContain('price_sensitive');
  });

  it('never leaves an inverted band when routine meets price sensitive', () => {
    // A price-sensitive "Results of Meeting" is not routine paperwork: the
    // floor wins and the ceiling is lifted to meet it.
    const v = classify(['Results of Meeting'], 'Results of Meeting', true);
    expect(v.floor).toBe(3);
    expect(v.ceiling).toBeGreaterThanOrEqual(v.floor);
    expect(applyBounds(1, v)).toBe(3);
  });

  it('matches types regardless of case, spacing and curly apostrophes', () => {
    expect(classify(["Change of Director’s Interest Notice"], '', false).ceiling).toBe(2);
    expect(classify(['  TRADING   HALT  '], '', false).floor).toBe(4);
  });

  it('reads the headline too, since the type is often generic', () => {
    const v = classify(['General Announcement'], 'Becoming a substantial holder', false);
    expect(v.floor).toBe(4);
  });

  it('leaves unknown types wide open for the model to judge', () => {
    const v = classify(['Presentation'], 'Investor Presentation', false);
    expect(v).toMatchObject({ floor: 1, ceiling: 5, flags: [] });
  });

  it('does not match acronyms inside longer words', () => {
    // Regressions caught in review: "nta" inside "prese-nta-tion" capped real
    // announcements at 2, and "asic" inside "b-asic" floored them at 4.
    expect(classify([], 'Investor Presentation', false).ceiling).toBe(5);
    expect(classify([], 'Basic Earnings Per Share', false).floor).toBe(1);
    // The acronyms still match as standalone words.
    expect(classify(['Monthly NTA'], '', false).ceiling).toBe(2);
    expect(classify([], 'ASIC commences proceedings', false).floor).toBe(4);
  });

  it('uses element 0 semantics but scans every type in the array', () => {
    const v = classify(['Dividend Rate', 'Dividend Record Date', 'Trading Halt'], '', false);
    expect(v.floor).toBe(4);
  });
});

describe('applyBounds', () => {
  const routine = classify(['Cleansing Notice'], '', false);
  const halt = classify(['Trading Halt'], '', false);

  it('pulls an over-eager score down to the ceiling', () => {
    expect(applyBounds(5, routine)).toBe(2);
  });

  it('pushes a buried score up to the floor', () => {
    expect(applyBounds(1, halt)).toBe(4);
  });

  it('leaves a score inside the band alone', () => {
    expect(applyBounds(2, routine)).toBe(2);
    expect(applyBounds(5, halt)).toBe(5);
  });
});

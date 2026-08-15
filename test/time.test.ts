import { describe, expect, it } from 'vitest';
import { isMarketWindow, sydneyParts } from '../src/lib/time';

/**
 * Sydney observes DST, so the market window sits at a different UTC offset in
 * January (AEDT, +11) than in July (AEST, +10). These boundary instants fail
 * against any hardcoded offset, which is the regression worth guarding.
 */
describe('isMarketWindow', () => {
  it('opens at 07:00 AEDT in January (UTC+11)', () => {
    expect(isMarketWindow(new Date('2026-01-14T19:59:00Z'))).toBe(false); // 06:59
    expect(isMarketWindow(new Date('2026-01-14T20:00:00Z'))).toBe(true); //  07:00
  });

  it('closes at 20:00 AEDT in January', () => {
    expect(isMarketWindow(new Date('2026-01-15T08:59:00Z'))).toBe(true); //  19:59
    expect(isMarketWindow(new Date('2026-01-15T09:00:00Z'))).toBe(false); // 20:00
  });

  it('opens at 07:00 AEST in July (UTC+10)', () => {
    expect(isMarketWindow(new Date('2026-07-14T20:59:00Z'))).toBe(false); // 06:59
    expect(isMarketWindow(new Date('2026-07-14T21:00:00Z'))).toBe(true); //  07:00
  });

  it('closes at 20:00 AEST in July', () => {
    expect(isMarketWindow(new Date('2026-07-15T09:59:00Z'))).toBe(true); //  19:59
    expect(isMarketWindow(new Date('2026-07-15T10:00:00Z'))).toBe(false); // 20:00
  });

  it('is silent at weekends', () => {
    // Saturday midday Sydney — inside the hour range, wrong day.
    expect(isMarketWindow(new Date('2026-07-18T02:00:00Z'))).toBe(false);
    // Sunday midday Sydney.
    expect(isMarketWindow(new Date('2026-07-19T02:00:00Z'))).toBe(false);
  });

  it('is silent overnight', () => {
    expect(isMarketWindow(new Date('2026-07-15T15:00:00Z'))).toBe(false); // 01:00 Thu
  });
});

describe('sydneyParts', () => {
  it('renders midnight as hour 0, not 24', () => {
    // 00:30 Sydney on a Thursday in July.
    expect(sydneyParts(new Date('2026-07-15T14:30:00Z')).hour).toBe(0);
  });

  it('maps weekdays to 0=Sunday', () => {
    expect(sydneyParts(new Date('2026-07-15T02:00:00Z')).weekday).toBe(3); // Wed
    expect(sydneyParts(new Date('2026-07-18T02:00:00Z')).weekday).toBe(6); // Sat
  });
});

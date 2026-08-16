import { describe, expect, it } from 'vitest';
import { parseFileSizeKb } from '../src/lib/asx';
import { prepareItem } from '../src/scheduled';
import { FeedResponseSchema } from '../src/lib/schema';

/**
 * Verbatim items from the live feed, captured 2026-08-16. The build brief
 * claimed `fileSize` was a number and that `sector`/`industry` were top-level;
 * both are wrong, and the first of those rejected every item at the zod gate
 * and stopped ingestion completely. This fixture is the guard against a silent
 * repeat.
 */
const LIVE_PAYLOAD = {
  data: {
    items: [
      {
        announcementTypes: ['End of Day'],
        companies: [{ symbolDisplay: 'ZOR' }],
        companyInfo: [], // no company record at all
        date: '2026-08-14T09:30:11.000Z',
        documentKey: '2924-03121409-6A1338688',
        fileSize: '102KB', // string, not number
        headline: 'End of Day',
        isPriceSensitive: false,
        symbol: 'ZOR',
        symbolsSecondary: ['ZOR', ''],
        url: '',
      },
      {
        announcementTypes: ['Appendix 3G'],
        companies: [{ symbolDisplay: 'NST' }],
        companyInfo: [
          {
            symbol: 'NST',
            xid: '217509',
            displayName: 'NORTHERN STAR RESOURCES LTD',
            issueType: 'CS',
            isin: 'AU000000NST8',
            sector: 'Materials', // nested, not top-level
            industryGroup: 'Materials',
            industry: 'Metals & Mining',
            subIndustry: 'Gold',
          },
        ],
        date: '2026-08-14T09:29:01.000Z',
        documentKey: '2924-03121407-6A1338689',
        fileSize: '14KB',
        headline: 'Notification regarding unquoted securities - NST',
        isPriceSensitive: false,
        symbol: 'NST',
        url: '',
      },
      {
        announcementTypes: [
          'Takeover - Other',
          'Director Appointment/Resignation',
          'Company Administration - Other',
        ],
        companyInfo: [
          {
            symbol: 'RCT',
            displayName: 'REEF CASINO TRUST',
            isin: 'AU000000RCT3',
            sector: 'Consumer Discretionary',
            industry: 'Hotels, Restaurants & Leisure',
          },
        ],
        date: '2026-08-14T09:12:46.000Z',
        documentKey: '2924-03121402-2A1689667',
        fileSize: '164KB',
        headline: 'Close of Iris takeover offer and board changes',
        isPriceSensitive: false,
        symbol: 'RCT',
        url: '',
      },
    ],
    count: 10000,
  },
};

describe('live feed payload', () => {
  it('passes the zod gate', () => {
    const parsed = FeedResponseSchema.safeParse(LIVE_PAYLOAD);
    expect(parsed.success).toBe(true);
  });

  const COLUMNS = [
    'document_key',
    'symbol',
    'company_name',
    'headline',
    'announcement_type',
    'types_json',
    'lodged_at',
    'is_price_sensitive',
    'file_size_kb',
    'isin',
    'sector',
    'industry',
    'first_seen_at',
    'rule_floor',
    'rule_ceiling',
    'rule_flags_json',
  ] as const;

  const bind = (index: number, column: (typeof COLUMNS)[number]): unknown => {
    const item = FeedResponseSchema.parse(LIVE_PAYLOAD).data.items[index];
    const prepared = prepareItem(item!, '2026-08-16T03:00:00.000Z');
    expect(prepared).not.toBeNull();
    return prepared!.binds[COLUMNS.indexOf(column)];
  };

  it('parses "102KB" into whole KB', () => {
    expect(bind(0, 'file_size_kb')).toBe(102);
    expect(bind(1, 'file_size_kb')).toBe(14);
  });

  it('falls back to the symbol when companyInfo is empty', () => {
    expect(bind(0, 'company_name')).toBe('ZOR');
    expect(bind(0, 'isin')).toBeNull();
    expect(bind(0, 'sector')).toBeNull();
  });

  it('reads sector and industry out of companyInfo, not the top level', () => {
    expect(bind(1, 'sector')).toBe('Materials');
    expect(bind(1, 'industry')).toBe('Metals & Mining');
    expect(bind(1, 'company_name')).toBe('NORTHERN STAR RESOURCES LTD');
  });

  it('keeps every announcement type but uses element 0 as primary', () => {
    expect(bind(2, 'announcement_type')).toBe('Takeover - Other');
    expect(JSON.parse(String(bind(2, 'types_json')))).toHaveLength(3);
  });

  it('floors a real takeover at materiality 4', () => {
    expect(bind(2, 'rule_floor')).toBe(4);
    expect(JSON.parse(String(bind(2, 'rule_flags_json')))).toContain('always_material');
  });

  it('does not mistake "Securities Trading Policy" for a trading halt', () => {
    const item = { ...LIVE_PAYLOAD.data.items[1]!, headline: 'Securities Trading Policy' };
    const prepared = prepareItem(FeedResponseSchema.parse({ data: { items: [item] } }).data.items[0]!, 'x');
    expect(prepared!.binds[COLUMNS.indexOf('rule_floor')]).toBe(1);
  });
});

describe('parseFileSizeKb', () => {
  it('handles the units the feed actually uses', () => {
    expect(parseFileSizeKb('102KB')).toBe(102);
    expect(parseFileSizeKb('3169KB')).toBe(3169);
    expect(parseFileSizeKb('76 KB')).toBe(76);
  });

  it('handles plausible variants without breaking', () => {
    expect(parseFileSizeKb(259)).toBe(259); // if the feed ever reverts to a number
    expect(parseFileSizeKb('1.5MB')).toBe(1536);
    expect(parseFileSizeKb('2,048KB')).toBe(2048);
    // Sub-KB rounds up to 1 rather than 0 — a non-empty file should never
    // render as "0 KB".
    expect(parseFileSizeKb('512B')).toBe(1);
  });

  it('returns null rather than a wrong number', () => {
    expect(parseFileSizeKb(undefined)).toBeNull();
    expect(parseFileSizeKb(null)).toBeNull();
    expect(parseFileSizeKb('')).toBeNull();
    expect(parseFileSizeKb('unknown')).toBeNull();
  });
});

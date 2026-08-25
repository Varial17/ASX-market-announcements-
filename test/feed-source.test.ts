import { describe, expect, it } from 'vitest';
import { toFeedItem, type FeedRow } from '../src/lib/db';

function row(overrides: Partial<FeedRow> = {}): FeedRow {
  return {
    document_key: '2924-03121397-6A1338684',
    symbol: 'FMR',
    company_name: 'FMR Resources Limited',
    headline: 'Ceasing to be a substantial holder',
    announcement_type: 'Other',
    types_json: '["Other"]',
    lodged_at: '2026-08-16T03:30:00.000Z',
    is_price_sensitive: 0,
    file_size_kb: 102,
    isin: null,
    sector: null,
    industry: null,
    pdf_r2_key: 'pdf/2924-03121397-6A1338684.pdf',
    first_seen_at: '2026-08-16T03:33:54.852Z',
    rule_floor: null,
    rule_ceiling: null,
    rule_flags_json: null,
    source: 'asx',
    ...overrides,
  };
}

describe('toFeedItem provenance', () => {
  it('flags an uploaded document as a test case', () => {
    const item = toFeedItem(row({ document_key: 'TEST-IFM-2A1612020', source: 'upload' }));
    expect(item.source).toBe('upload');
    expect(item.isTest).toBe(true);
  });

  it('leaves a polled ASX lodgement unflagged', () => {
    const item = toFeedItem(row());
    expect(item.source).toBe('asx');
    expect(item.isTest).toBe(false);
  });

  // Rows written before migration 0004 read back as NULL under a stale binding.
  // Defaulting those to 'asx' matters: the alternative is every historical row
  // silently appearing under the Test cases tab.
  it('treats a pre-migration null source as ASX, never as a test case', () => {
    const item = toFeedItem(row({ source: null }));
    expect(item.source).toBe('asx');
    expect(item.isTest).toBe(false);
  });
});

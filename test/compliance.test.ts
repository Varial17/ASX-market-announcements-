import { describe, expect, it } from 'vitest';
import {
  COMPLIANCE_CHECK_IDS,
  COMPLIANCE_LABELS,
  checkWatchlist,
  parseWatchlist,
} from '../src/lib/compliance';
import { RECORD_ANALYSIS_TOOL, SYSTEM_PROMPT } from '../src/lib/anthropic';
import { AnalysisSchema } from '../src/lib/schema';

describe('checklist definition', () => {
  it('covers all ten review criteria', () => {
    expect(COMPLIANCE_CHECK_IDS).toHaveLength(10);
  });

  it('keeps ids, labels and the tool schema in step', () => {
    const toolChecks = (
      RECORD_ANALYSIS_TOOL.input_schema.properties.compliance as {
        properties: { checks: { required: string[]; properties: Record<string, unknown> } };
      }
    ).properties.checks;

    expect(toolChecks.required.sort()).toEqual([...COMPLIANCE_CHECK_IDS].sort());
    expect(Object.keys(toolChecks.properties).sort()).toEqual([...COMPLIANCE_CHECK_IDS].sort());
    expect(Object.keys(COMPLIANCE_LABELS).sort()).toEqual([...COMPLIANCE_CHECK_IDS].sort());
  });

  it('tells the model that an unperformable check is not a pass', () => {
    expect(SYSTEM_PROMPT).toMatch(/not_assessable.*never `pass`|never `pass`/s);
    expect(SYSTEM_PROMPT).toContain('not a determination by ASX');
  });
});

describe('watch list', () => {
  it('reads a comma or space separated list, case-insensitively', () => {
    expect([...parseWatchlist('bhp, rio  wes')]).toEqual(['BHP', 'RIO', 'WES']);
    expect(parseWatchlist(undefined).size).toBe(0);
    expect(parseWatchlist('').size).toBe(0);
  });

  it('reports an unconfigured list as not assessable, never as a pass', () => {
    const verdict = checkWatchlist('BHP', parseWatchlist(''));
    expect(verdict.status).toBe('not_assessable');
    expect(verdict.status).not.toBe('pass');
    expect(verdict.note).toContain('WATCHLIST_TICKERS');
  });

  it('flags a listed entity for additional review', () => {
    expect(checkWatchlist('bhp', parseWatchlist('BHP,RIO')).status).toBe('query');
  });

  it('passes an entity that is genuinely not listed', () => {
    expect(checkWatchlist('CBA', parseWatchlist('BHP,RIO')).status).toBe('pass');
  });
});

describe('analysis validation', () => {
  const complete = {
    category: 'ownership',
    direction: 'neutral',
    materiality: 4,
    confidence: 0.8,
    summary: 'A holder crossed 5%.',
    why_it_matters: 'Substantial holder notices show who is accumulating.',
    figures: [],
    flags: [],
    compliance: {
      overall: 'query',
      checks: Object.fromEntries(
        COMPLIANCE_CHECK_IDS.map((id) => [id, { status: 'pass', note: 'Checked.' }]),
      ),
    },
  };

  it('accepts a fully answered checklist', () => {
    expect(AnalysisSchema.safeParse(complete).success).toBe(true);
  });

  it('rejects a checklist with a box left unticked', () => {
    const { title: _dropped, ...rest } = complete.compliance.checks as Record<string, unknown>;
    const partial = { ...complete, compliance: { ...complete.compliance, checks: rest } };
    // A missing check must fail validation — rendering it as a blank row would
    // read as a silent pass.
    expect(AnalysisSchema.safeParse(partial).success).toBe(false);
  });

  it('rejects an invented status', () => {
    const bad = {
      ...complete,
      compliance: {
        ...complete.compliance,
        checks: { ...complete.compliance.checks, title: { status: 'probably_fine', note: 'x' } },
      },
    };
    expect(AnalysisSchema.safeParse(bad).success).toBe(false);
  });
});

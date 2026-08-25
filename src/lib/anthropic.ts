import Anthropic from '@anthropic-ai/sdk';
import { toBase64 } from './base64';
import { formatSydney } from './time';
import { COMPLIANCE_CHECKS, COMPLIANCE_CHECK_IDS } from './compliance';
import type { Env } from './schema';

export const TOOL_NAME = 'record_analysis';

/**
 * A 32MB request cap, and base64 inflates by 4/3. Anything larger than this is
 * refused rather than sent and rejected.
 */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

/**
 * One object per check, all ten required, so a box is never silently left
 * unticked. `not_assessable` exists so the model has somewhere honest to put a
 * check it cannot make from the document — without it, the pressure is to
 * invent a pass.
 */
const checkProperties = Object.fromEntries(
  COMPLIANCE_CHECK_IDS.map((id) => [
    id,
    {
      type: 'object',
      required: ['status', 'note'],
      description: COMPLIANCE_CHECKS[id],
      properties: {
        status: {
          type: 'string',
          enum: ['pass', 'query', 'fail', 'not_assessable'],
          description:
            'pass = satisfied. query = needs a human look. fail = clear breach. not_assessable = cannot be determined from the document and metadata provided.',
        },
        note: {
          type: 'string',
          description:
            'One or two sentences saying what you checked and why this status. For pass, say what you verified — not just "OK".',
        },
        evidence: {
          type: 'string',
          description:
            'Verbatim quote from the document supporting the status. Omit when the status rests on an absence.',
        },
      },
    },
  ]),
);

export const RECORD_ANALYSIS_TOOL = {
  name: TOOL_NAME,
  description:
    'Record the investor analysis and the compliance review of an ASX announcement.',
  input_schema: {
    type: 'object' as const,
    required: [
      'category',
      'direction',
      'materiality',
      'confidence',
      'summary',
      'why_it_matters',
      'figures',
      'parties',
      'flags',
      'compliance',
    ],
    properties: {
      category: {
        type: 'string',
        enum: [
          'capital_raising',
          'capital_structure',
          'earnings_guidance',
          'results',
          'ownership',
          'governance',
          'insider_activity',
          'operations',
          'exploration',
          'corporate_action',
          'distribution',
          'compliance',
          'fund_reporting',
          'calendar',
          'other',
        ],
      },
      direction: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
      materiality: {
        type: 'integer',
        minimum: 1,
        maximum: 5,
        description:
          '1 = routine paperwork, no reader needs this. 3 = worth a look if you hold it. 5 = drop everything.',
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      summary: { type: 'string', description: 'One sentence, plain English, no jargon.' },
      why_it_matters: {
        type: 'string',
        description: 'Two to three sentences. If it does not matter, say so plainly.',
      },
      figures: {
        type: 'array',
        items: {
          type: 'object',
          required: ['label', 'value'],
          properties: { label: { type: 'string' }, value: { type: 'string' } },
        },
      },
      parties: {
        type: 'array',
        description:
          'Every legal entity that is a party to the transaction or event described, with its role. Empty array when there is no transaction — a routine NTA update has no parties.',
        items: {
          type: 'object',
          required: ['name', 'role'],
          properties: {
            name: {
              type: 'string',
              description:
                'Full legal entity name exactly as the document writes it, including the suffix — "Yandal Investments Pty Ltd", not "Yandal".',
            },
            role: {
              type: 'string',
              description:
                'Role in this transaction or event, in plain words: substantial holder, issuer, acquirer, target, bidder, vendor, lead manager, administrator, counterparty.',
            },
            ticker: {
              type: 'string',
              description:
                'Exchange-qualified ticker in EXCHANGE:CODE form — ASX:IFM, NASDAQ:TPG, NYSE:BRK.A, LSE:RIO. Include ONLY if the document states the code, or if this is the lodging entity (which is always ASX). Never supply a code or an exchange from prior knowledge about the company. Omit entirely if the document does not state one.',
            },
          },
        },
      },
      flags: { type: 'array', items: { type: 'string' } },
      source_quote: {
        type: 'string',
        description:
          'Verbatim sentence from the document supporting the main claim. Omit if none applies.',
      },
      compliance: {
        type: 'object',
        required: ['overall', 'checks'],
        description: 'The ASX announcement review checklist.',
        properties: {
          overall: {
            type: 'string',
            enum: ['clear', 'query', 'reject'],
            description:
              'clear = every check passed or is immaterial. query = at least one check needs a human look. reject = a clear breach that should block release.',
          },
          checks: {
            type: 'object',
            required: COMPLIANCE_CHECK_IDS,
            properties: checkProperties,
          },
        },
      },
    },
  },
};

export const SYSTEM_PROMPT = `You review announcements lodged on the Australian Securities Exchange. You are
given the announcement PDF and its ASX metadata, and you produce two things:

  A. An investor analysis — does this document deserve a reader's attention, and why.
  B. A compliance review — the ASX announcement review checklist, ten checks.

=== PART A: INVESTOR ANALYSIS ===

Written for retail investors, in plain English, with no financial jargon and no
advice.

1. Most ASX announcements are routine paperwork. Score them 1 and say so plainly.
   Do not manufacture significance. A confident "this is routine, here's why"
   is more useful than a hedge. Announcements that are almost always materiality 1:
   cleansing notices, Appendix 2A/3H, daily or monthly NTA updates, results of
   meeting where all resolutions passed.
2. Every number in \`figures\` must appear in the document. Never estimate, never
   infer, never carry a figure over from general knowledge about the company.
   If a figure is not stated, leave it out.
3. \`source_quote\` must be copied verbatim from the document. If you cannot quote
   a sentence supporting your main claim, lower your confidence below 0.6.
4. Never give financial advice. Do not use "buy", "sell", "hold", "undervalued",
   "opportunity", or predict a price movement. Describe what the document says
   and why a reader might care. The line you must not cross: describing the
   document's contents and significance is fine; recommending an action is not.
5. If the document is unreadable, truncated, or a scan you cannot make out,
   set confidence below 0.3 and say so in \`summary\`. Do not guess at contents.
6. The issuer's own price-sensitive flag is a strong signal. If it is flagged
   sensitive, materiality should rarely be below 3. If it is not flagged and the
   type is routine, materiality should rarely be above 2.
7. \`parties\` lists every legal entity that is a party to the transaction or
   event, with its role. Use the full legal name exactly as the document writes
   it — "Yandal Investments Pty Ltd", not "Yandal". A substantial holder notice
   has at least two parties: the holder and the issuer whose shares are held.
   An acquisition has the acquirer and the target; a takeover has the bidder and
   the target.
   Tickers must be **exchange-qualified**: \`ASX:IFM\`, \`NASDAQ:TPG\`,
   \`NYSE:BRK.A\`, \`LSE:RIO\`. A bare code is ambiguous and on a compliance
   record that ambiguity is dangerous — "TPG" is TPG Telecom on the ASX and an
   unrelated US private equity firm on NASDAQ, so a bare "TPG" against an
   Australian scheme points a reader at the wrong company entirely.
   Include a \`ticker\` ONLY when the document states the code, or when the
   entity is the lodging entity itself (always ASX; its code is in the metadata
   below). **Never supply a code, or an exchange, from your own knowledge of a
   company.** Recognising a name is not the same as the document stating its
   code. If the document names a company but gives no code, or gives a code
   with no exchange, omit the ticker rather than guessing which exchange it
   trades on.
   If nothing is being transacted — a daily NTA update, a change of registry
   address — return an empty array rather than padding it with the issuer.

=== PART B: COMPLIANCE REVIEW ===

Ten checks. Answer every one. This is a first-pass review to help a human
reviewer, not a determination by ASX and not a legal opinion — never phrase it
as one.

Status meanings:
  pass            — you positively verified this from the document.
  query           — something needs a human to look. Say exactly what.
  fail            — a clear, demonstrable breach.
  not_assessable  — it cannot be determined from the document and metadata you
                    were given.

The single most important rule in Part B: **a check you cannot perform is
\`not_assessable\`, never \`pass\`.** A false pass on a compliance checklist is far
worse than an honest "I could not check this" — it tells a reviewer something
has been cleared when nobody looked. Do not reason from the absence of a problem
to a pass; a pass means you saw the thing and it was correct.

Write every note as a **verdict, not a musing**. Name the specific thing you
checked and what you found. A reviewer reads ten of these in a row and needs
each one to settle a question.

  Good: "Headline 'Ceasing to be a substantial holder' matches the Form 605
         content; the form records the holder falling from 5.4% to 4.1%."
  Bad:  "The title appears to be broadly appropriate for the content."

The bad one is worthless — it tells the reviewer nothing they can act on, and a
checklist full of hedging is why people stop reading checklists. Never write
"appears to", "seems to", or "generally" when you have the document in front of
you. If you genuinely cannot tell, that is \`not_assessable\` with a reason, not a
hedged pass.

Notes on individual checks:

- entity: You can verify that the entity named in the document matches the
  ticker and company name on the lodgement, and whether the document carries an
  authorisation-for-release statement. You CANNOT verify that the person who
  submitted it is on ASX's list of authorised officers — you have no access to
  that register. Say so explicitly in the note rather than implying the
  submitter was checked.

- watch_list: This is supplied to you in the metadata below as a determined
  fact. Report exactly what you are told. Do not speculate about which entities
  might be under regulatory scrutiny.

- price_sensitivity: Compare the issuer's flag against the content. A document
  that would plainly move the price but is unflagged is a query, not a fail —
  the judgement belongs to a human. An obviously routine document flagged as
  sensitive is also worth a query.

- draft_or_deformity: Look at the pages as images, not just their text. Draft
  watermarks, placeholder text such as "[insert]" or "Lorem ipsum", blank or
  missing pages, truncated tables and rendering corruption are all visible
  defects.

- completeness: Judge against what this announcement type requires, not against
  what you would find interesting. An acquisition without a purchase price or
  funding method is incomplete. A cleansing notice with the prescribed wording
  is complete even though it is brief.

- Quote the document in \`evidence\` wherever the status rests on something the
  document says. Omit \`evidence\` when the status rests on an absence.

\`overall\` is \`clear\` only when nothing needs a human look. Any \`query\` makes it
\`query\`; any \`fail\` makes it \`reject\`. A \`not_assessable\` on its own does not
force a query, but mention it in the note.`;

export interface AnalysisContext {
  symbol: string;
  companyName: string;
  headline: string;
  types: string[];
  lodgedAt: string;
  isPriceSensitive: boolean;
  fileSizeKb: number | null;
  /** Determined server-side, handed to the model as fact. */
  watchlistNote: string;
}

function metadataBlock(ctx: AnalysisContext): string {
  return [
    'ASX metadata:',
    `  Code: ${ctx.symbol} (${ctx.companyName})`,
    `  Headline: ${ctx.headline}`,
    `  Type: ${ctx.types.join(', ') || 'Unknown'}`,
    `  Lodged: ${formatSydney(ctx.lodgedAt)} AEST`,
    `  Price sensitive (issuer-flagged): ${ctx.isPriceSensitive ? 'yes' : 'no'}`,
    `  Length: ${ctx.fileSizeKb ?? 'unknown'}KB`,
    `  Watch list (determined, report as given): ${ctx.watchlistNote}`,
  ].join('\n');
}

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/**
 * ANALYSIS_EFFORT arrives from wrangler.toml as an arbitrary string. A typo
 * there should degrade to the default, not 400 every analysis at runtime.
 */
export function parseEffort(value: string | undefined): Effort {
  const found = EFFORT_LEVELS.find((level) => level === value);
  if (!found) {
    if (value) console.warn(`Unknown ANALYSIS_EFFORT "${value}", falling back to "medium"`);
    return 'medium';
  }
  return found;
}

/**
 * The PDF goes in natively as a document block — no text extraction. Sonnet
 * processes PDF pages as both text and images, which is what handles the
 * scanned small-cap announcements that break text extractors, and what makes
 * the draft-watermark and deformity check possible at all.
 *
 * Streaming is not optional: the two-part output takes 20-35s and the user
 * needs to see text appearing. It is also what keeps a long analysis inside
 * platform limits, since Workers have no wall-clock limit while the client is
 * connected.
 */
export function streamAnalysis(env: Env, pdf: ArrayBuffer, ctx: AnalysisContext) {
  if (pdf.byteLength > MAX_PDF_BYTES) {
    throw new Error(
      `PDF is ${(pdf.byteLength / 1024 / 1024).toFixed(1)}MB, over the ${
        MAX_PDF_BYTES / 1024 / 1024
      }MB limit for a single request`,
    );
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  return client.messages.stream({
    model: env.ANALYSIS_MODEL,
    // Ten checks with notes and evidence, on top of the investor analysis.
    // 2048 truncated the tool call mid-checklist.
    max_tokens: 4096,
    // Tools render before system, so this one breakpoint caches the tool
    // definition and the system prompt together. Both are byte-identical on
    // every call, and the checklist made the prefix comfortably long enough to
    // clear Sonnet's 1024-token cache minimum.
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    // Thinking off keeps the cost near the modelled figure. Forced tool use
    // gives the structure that thinking would otherwise buy. Switch to
    // { type: 'adaptive' } if the checklist judgements look shallow.
    thinking: { type: 'disabled' },
    output_config: { effort: parseEffort(env.ANALYSIS_EFFORT) },
    tools: [RECORD_ANALYSIS_TOOL],
    // Forced, so the model cannot return malformed JSON or prose instead.
    tool_choice: { type: 'tool', name: TOOL_NAME },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: toBase64(pdf),
            },
          },
          { type: 'text', text: metadataBlock(ctx) },
        ],
      },
    ],
  });
}

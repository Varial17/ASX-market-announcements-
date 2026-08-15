import Anthropic from '@anthropic-ai/sdk';
import { toBase64 } from './base64';
import { formatSydney } from './time';
import type { Env } from './schema';

export const TOOL_NAME = 'record_analysis';

/**
 * A 32MB request cap, and base64 inflates by 4/3. Anything larger than this is
 * refused rather than sent and rejected.
 */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

export const RECORD_ANALYSIS_TOOL = {
  name: TOOL_NAME,
  description: 'Record the structured analysis of an ASX announcement.',
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
      'flags',
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
      flags: { type: 'array', items: { type: 'string' } },
      source_quote: {
        type: 'string',
        description:
          'Verbatim sentence from the document supporting the main claim. Omit if none applies.',
      },
    },
  },
};

export const SYSTEM_PROMPT = `You analyse announcements lodged on the Australian Securities Exchange for retail
investors. You are given the announcement PDF and its ASX metadata.

Your job is to tell the reader whether this document deserves their attention, and
if so, why — in plain English, with no financial jargon and no advice.

Rules:
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
   type is routine, materiality should rarely be above 2.`;

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

export interface AnalysisContext {
  symbol: string;
  companyName: string;
  headline: string;
  types: string[];
  lodgedAt: string;
  isPriceSensitive: boolean;
  fileSizeKb: number | null;
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
  ].join('\n');
}

/**
 * The PDF goes in natively as a document block — no text extraction. Sonnet
 * processes PDF pages as both text and images, which is what handles the
 * scanned small-cap announcements that break text extractors.
 *
 * Streaming is not optional: a 27-page prospectus takes 15-25s and the user
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
    max_tokens: 2048,
    // Tools render before system, so this one breakpoint caches the tool
    // definition and the system prompt together. Both are byte-identical on
    // every call. Note Sonnet's minimum cacheable prefix is 1024 tokens — if
    // usage.cache_read_input_tokens stays at 0, the prefix is simply too short
    // to cache, which costs nothing but saves nothing.
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    // Thinking off keeps this at the modelled ~$0.016/analysis. Forced tool
    // use gives the structure that thinking would otherwise buy. Switch to
    // { type: 'adaptive' } if materiality calls look shallow on long documents.
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

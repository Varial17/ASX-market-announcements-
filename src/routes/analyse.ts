import { getPdf } from '../lib/asx';
import { streamAnalysis, TOOL_NAME } from '../lib/anthropic';
import { applyBounds, type RuleVerdict } from '../lib/rules';
import { json, saveAnalysis, toAnalysis, type AnalysisRow, type AnnouncementRow } from '../lib/db';
import { AnalysisSchema, type Env } from '../lib/schema';

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function verdictFor(row: AnnouncementRow): RuleVerdict {
  let flags: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.rule_flags_json ?? '[]');
    if (Array.isArray(parsed)) flags = parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    flags = [];
  }
  return { floor: row.rule_floor ?? 1, ceiling: row.rule_ceiling ?? 5, flags };
}

/**
 * POST /api/announcements/:document_key/analyse
 *
 * The cache check is first, always. It is the whole cost model: an
 * announcement is analysed once and served free to every visitor after that.
 */
export async function handleAnalyse(
  _request: Request,
  env: Env,
  ctx: ExecutionContext,
  documentKey: string,
): Promise<Response> {
  const cached = await env.DB.prepare('SELECT * FROM analyses WHERE document_key = ?')
    .bind(documentKey)
    .first<AnalysisRow>();

  if (cached) {
    // Logged so "second click costs nothing" is verifiable in `wrangler tail`
    // rather than merely assumed.
    console.log(
      JSON.stringify({ event: 'analysis_cache_hit', documentKey, anthropicCalls: 0 }),
    );
    return json({ cached: true, analysis: toAnalysis(cached) }, {
      headers: { 'X-Analysis-Cache': 'hit' },
    });
  }

  const announcement = await env.DB.prepare('SELECT * FROM announcements WHERE document_key = ?')
    .bind(documentKey)
    .first<AnnouncementRow>();

  if (!announcement) {
    return json({ error: 'not_found', documentKey }, { status: 404 });
  }

  let pdf: ArrayBuffer;
  try {
    const result = await getPdf(env, documentKey);
    pdf = result.body;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: 'pdf_fetch_failed', documentKey, message }));
    return json({ error: 'pdf_unavailable', message }, { status: 502 });
  }

  let types: string[] = [];
  try {
    const parsed: unknown = JSON.parse(announcement.types_json);
    if (Array.isArray(parsed)) types = parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    types = [announcement.announcement_type];
  }

  const verdict = verdictFor(announcement);
  const encoder = new TextEncoder();

  // Started before the ReadableStream so an oversized PDF is a clean 413
  // rather than an SSE error the client has to unwrap.
  let stream: ReturnType<typeof streamAnalysis>;
  try {
    stream = streamAnalysis(env, pdf, {
      symbol: announcement.symbol,
      companyName: announcement.company_name,
      headline: announcement.headline,
      types,
      lodgedAt: announcement.lodged_at,
      isPriceSensitive: announcement.is_price_sensitive === 1,
      fileSizeKb: announcement.file_size_kb,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: 'pdf_too_large', message }, { status: 413 });
  }

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Once the client disconnects, enqueue throws. Swallowing it here keeps
      // a closed tab from surfacing as an unhandled rejection.
      let open = true;
      const send = (event: string, data: unknown): void => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(sse(event, data)));
        } catch {
          open = false;
        }
      };

      try {
        send('meta', { documentKey, model: env.ANALYSIS_MODEL, cached: false });

        // Forced tool use means the payload arrives as input_json_delta
        // fragments. Relaying them lets the client render fields as they land
        // instead of showing a spinner for 20 seconds.
        for await (const event of stream) {
          if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'input_json_delta' &&
            event.delta.partial_json
          ) {
            send('delta', { json: event.delta.partial_json });
          }
        }

        const final = await stream.finalMessage();
        const toolUse = final.content.find(
          (block) => block.type === 'tool_use' && block.name === TOOL_NAME,
        );

        if (!toolUse || toolUse.type !== 'tool_use') {
          throw new Error(`Model returned no ${TOOL_NAME} tool call (stop: ${final.stop_reason})`);
        }

        const parsed = AnalysisSchema.safeParse(toolUse.input);
        if (!parsed.success) {
          throw new Error(`Analysis failed validation: ${parsed.error.message}`);
        }

        // Rules are for certainty, the model is for nuance. The stored score
        // is the clamped one, so a cleansing notice can never be dressed up as
        // a 4 and a trading halt can never be buried at 1.
        const analysis = {
          ...parsed.data,
          materiality: applyBounds(parsed.data.materiality, verdict),
        };

        const meta = {
          model: final.model,
          inputTokens: final.usage.input_tokens ?? null,
          outputTokens: final.usage.output_tokens ?? null,
        };

        console.log(
          JSON.stringify({
            event: 'analysis_generated',
            documentKey,
            model: final.model,
            inputTokens: meta.inputTokens,
            outputTokens: meta.outputTokens,
            cacheReadInputTokens: final.usage.cache_read_input_tokens ?? 0,
            modelMateriality: parsed.data.materiality,
            storedMateriality: analysis.materiality,
          }),
        );

        send('result', { analysis, ...meta });

        // Never block the response on the write.
        ctx.waitUntil(saveAnalysis(env.DB, documentKey, analysis, meta));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(JSON.stringify({ event: 'analysis_failed', documentKey, message }));
        send('error', { message });
      } finally {
        open = false;
        try {
          controller.close();
        } catch {
          // Already closed by a client disconnect.
        }
      }
    },

    // The user closed the tab. Stop paying for tokens nobody will read.
    cancel() {
      stream.abort();
    },
  });

  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Analysis-Cache': 'miss',
    },
  });
}

import { handleAnalyse } from './routes/analyse';
import { handleDetail } from './routes/detail';
import { handleFeed } from './routes/feed';
import { handleHealth } from './routes/health';
import { handlePdf } from './routes/pdf';
import { handleUpload } from './routes/upload';
import { handleScheduled } from './scheduled';
import { json } from './lib/db';
import type { Env } from './lib/schema';

/**
 * Static assets are matched first (see [assets] in wrangler.toml); anything
 * that is not a file on disk arrives here. In practice that means /api/*.
 */
async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/health') {
    return handleHealth(request, env);
  }

  if (path === '/api/announcements') {
    return handleFeed(request, env);
  }

  const analyse = /^\/api\/announcements\/([^/]+)\/analyse$/.exec(path);
  if (analyse?.[1]) {
    if (request.method !== 'POST') {
      return json({ error: 'method_not_allowed', expected: 'POST' }, { status: 405 });
    }
    return handleAnalyse(request, env, ctx, decodeURIComponent(analyse[1]));
  }

  const detail = /^\/api\/announcements\/([^/]+)$/.exec(path);
  if (detail?.[1]) {
    return handleDetail(request, env, decodeURIComponent(detail[1]));
  }

  const pdf = /^\/api\/pdf\/([^/]+)$/.exec(path);
  if (pdf?.[1]) {
    const documentKey = decodeURIComponent(pdf[1]);
    if (request.method === 'PUT') return handleUpload(request, env, documentKey);
    return handlePdf(request, env, documentKey);
  }

  return json({ error: 'not_found', path }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ event: 'unhandled_error', message }));
      return json({ error: 'internal_error', message }, { status: 500 });
    }
  },

  scheduled: handleScheduled,
} satisfies ExportedHandler<Env>;

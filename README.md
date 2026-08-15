# ASX Announcement Screener

Shows every ASX company announcement as it is lodged, and generates an AI analysis of any
announcement on demand — caching the result permanently so it is only ever generated once.

Everything runs on Cloudflare: Workers (API + cron), D1 (database), R2 (PDF cache), Workers
Static Assets (frontend). One `wrangler.toml`, one deploy.

---

## ⚠️ Legal — read before deploying anywhere public

ASX states on its announcements page:

> **"The content of ASX market announcements must not be used for commercial purposes."**

This build is a **private prototype**. Before any public launch or paid tier, a Marketsource
agreement with ASX Information Services (information.services@asx.com.au) or a licensed vendor
feed is required.

**Do not deploy this on a public domain with a payment page.** Keep it behind Cloudflare Access
or a shared password.

The app is information only. It is not financial advice, and the analysis is AI-generated and
may contain errors — the disclaimer footer says so on every page and must stay there.

---

## Prerequisites

1. **Workers Paid ($5/mo) — required, not optional.** The free plan caps CPU at 10 ms per
   request, which is not enough to parse a 50-item JSON payload and write it to D1. Paid gives
   30 s.
2. **R2 enabled on the account.** One-time: Cloudflare dashboard → R2 → Enable. The API returns
   `Please enable R2 through the Cloudflare Dashboard` until you do.
3. Node 22+ and an Anthropic API key.

## Setup

```bash
npm install

# 1. R2 bucket (D1 database already exists — see wrangler.toml)
npx wrangler r2 bucket create asx-pdfs

# 2. Schema
npm run migrate:remote          # or `npm run migrate:local` for local dev

# 3. Secrets
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ASX_ACCESS_TOKEN     # 83ff96335c2d45a094df02a206a39ff4
npx wrangler secret put ALERT_WEBHOOK_URL    # optional; Slack/Discord incoming webhook

# 4. Deploy (builds the frontend into ./public first)
npm run deploy
```

The D1 database `asx-screener` was created during the initial build and its `database_id` is
already in `wrangler.toml`. If you recreate it, update that ID.

### Local development

```bash
cp .dev.vars.example .dev.vars   # fill in your keys
npm run migrate:local
npm run dev                      # builds the frontend, then runs wrangler dev
```

`.dev.vars` is gitignored. Note that cron triggers do not fire automatically in `wrangler dev`;
trigger the poller manually with
`curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"`.

---

## How it works

```
/src
  index.ts            router: /api/* (static assets are matched first)
  scheduled.ts        cron handler — the poller and the staleness watchdog
  /routes
    feed.ts           GET  /api/announcements
    detail.ts         GET  /api/announcements/:key
    analyse.ts        POST /api/announcements/:key/analyse   (streams SSE)
    pdf.ts            GET  /api/pdf/:key                     (R2-backed proxy)
    health.ts         GET  /api/health
  /lib
    asx.ts            feed client, PDF fetch, R2 caching, backoff
    anthropic.ts      the analysis call — tool schema, system prompt, streaming
    rules.ts          deterministic flags and materiality bounds
    schema.ts         zod schemas + the Env binding types
    time.ts           Australia/Sydney market-hours logic
    db.ts             row types, mappers, analysis persistence
/migrations           0001_init.sql
/frontend             vanilla TS + Vite → builds into /public
```

### The poller

Runs every minute (the Cron Triggers platform minimum), but is a **no-op outside 07:00–20:00
Australia/Sydney, Mon–Fri** — no request is made and no `ingest_runs` row is written, so an
empty overnight never looks like a failure. Sydney observes DST, so the window is computed with
`Intl` rather than a fixed UTC offset; `test/time.test.ts` pins both the AEDT and AEST
boundaries.

Dedupe is free: `document_key` is the primary key and inserts are `INSERT OR IGNORE`, batched.
There is no SELECT-then-INSERT. The handler never throws — a thrown cron handler is retried by
the platform, which would hammer the source.

PDFs are **not** downloaded by the poller. They are fetched lazily on first analysis or first
view, then cached in R2 forever and never fetched twice.

### The analysis call

- The PDF goes to the model **natively as a document block** — no text extraction. Sonnet
  processes PDF pages as both text and images, which handles the scanned small-cap
  announcements that break text extractors.
- **Forced tool use** (`tool_choice: {type: 'tool'}`) so the model cannot return malformed JSON.
- The response **streams**. A 27-page prospectus takes 15–25 s and the user must see text
  appearing, not a spinner. The forced tool call arrives as `input_json_delta` fragments, which
  the Worker relays as SSE and the frontend renders progressively.
- **Thinking is disabled** and effort is `medium`, which is what keeps this at the modelled
  ~$0.016 per typical analysis. If materiality calls look shallow on long documents, switch
  `thinking` to `{type: 'adaptive'}` in `src/lib/anthropic.ts` and expect the cost to rise.

### The cache is the business model

`POST /api/announcements/:key/analyse` checks the `analyses` table **first, always**. A hit
returns plain JSON with `X-Analysis-Cache: hit` and logs
`{"event":"analysis_cache_hit","anthropicCalls":0}` — so "the second click costs nothing" is
verifiable in `wrangler tail`, not merely assumed. A miss returns `text/event-stream`; the
frontend branches on the content type.

Two users clicking Generate at the same moment is handled with `INSERT OR REPLACE`, not a lock.
Double-generating occasionally costs 2c and is not worth locking for.

### Rules before AI

`src/lib/rules.ts` runs at ingest with no model involved. It sets a materiality **floor** and
**ceiling**, and the model refines *within* those bounds — the stored score is always the
clamped one. Rules are for certainty, the model is for nuance.

- Floor 4: trading halts, suspensions, takeovers, substantial-holder notices, guidance changes,
  ASX price queries, ASIC action, administrator/receiver/liquidator appointments.
- Ceiling 2: cleansing notices, Appendix 2A/3H, NTA updates, director's interest notices,
  meeting notices and results.
- Anything issuer-flagged price sensitive gets a floor of 3 regardless of type.

Matching is **word-boundary**, not substring. This matters more than it looks: plain `includes`
matched `nta` inside "prese**nta**tion" (capping real announcements at 2) and `asic` inside
"**b**asic" (flooring "Basic Earnings Per Share" at 4). Both are pinned by regression tests.

### Reliability

Silent ingest failure is the bug that kills this product — if the poller stops at 10am and
nobody notices until Friday, the site has been confidently showing an empty market for four
days. So:

- `GET /api/health` reports the last successful ingest, its age, run and error counts for the
  last hour, and returns **503** when stale.
- An hourly cron checks for no successful ingest in 15 minutes *during market hours* and POSTs
  to `ALERT_WEBHOOK_URL` (the `text` field renders in both Slack and Discord). MailChannels is
  not used — it stopped being available to Workers without a paid account, so a webhook is the
  quickest thing that actually works.
- The feed UI shows "updated HH:MM AEST" and raises a visible banner when the data is more than
  5 minutes old during market hours, rather than pretending it is current.
- A 401/403 from the ASX token gets its own error type and an explicit "the token has likely
  been rotated" message in the logs and in `ingest_runs.error`. **The access token is a public
  key lifted from the ASX site's own JavaScript and can be rotated without notice** — it lives
  in a secret, never in code.

### Being a good citizen

Polling is once per minute, market hours only. The `User-Agent` identifies the app and carries a
contact address (change it in `wrangler.toml` if you are not the original author). Every PDF is
cached in R2 on first fetch and never fetched again. Non-200s get exponential backoff; auth
failures are not retried at all.

---

## Cost

At Sonnet 5 pricing, roughly $0.006 for a 1-page cleansing notice, $0.016 for a typical 4-page
announcement, $0.053 for a 27-page prospectus. At 60 analyses/day that is **~$20/month** — and
because every result is cached forever on `document_key`, that is a one-time cost per
announcement no matter how many people view it.

Prompt caching is enabled on the system prompt + tool definition (they are byte-identical on
every call). Sonnet's minimum cacheable prefix is 1024 tokens, so if
`cache_read_input_tokens` stays at 0 in the logs, the prefix is simply too short to cache — that
costs nothing, it just saves nothing.

---

## API

| Route | Notes |
|---|---|
| `GET /api/announcements` | `?limit=` (≤200) `&filter=all\|price_sensitive\|analysed` `&q=` `&before=` (keyset cursor). Returns `lastIngestAt` for the staleness banner. |
| `GET /api/announcements/:key` | Announcement + analysis (or `null`) + `pdfUrl`. |
| `POST /api/announcements/:key/analyse` | JSON on cache hit, SSE (`meta`/`delta`/`result`/`error`) on miss. |
| `GET /api/pdf/:key` | Same-origin PDF proxy. This route exists so the document frames inline — a cross-origin PDF will not. Immutable cache headers. |
| `GET /api/health` | 200 when healthy, 503 when stale. |

## Tests

```bash
npm test          # rules engine + market-hours DST boundaries
npm run typecheck # worker and frontend
```

---

## Known gaps and deviations from the brief

- **Page count.** Rows show file size in KB. The feed's `fileSize` (a number, in KB) is all the
  metadata provides — there is no page count, and inferring one from bytes would be a fabricated
  number in a product whose whole premise is not fabricating numbers.
- **The design prototype was not supplied.** `asx-screener-prototype.html` was referenced in the
  brief but not present in the repo, so the frontend implements the described layout — list
  left, detail right, detail stacked metadata → analysis → PDF, PDF never narrower than 600px —
  rather than lifting its markup and CSS. Drop the prototype in and it can be reconciled.
- **The live feed could not be verified from the build environment**, whose egress policy blocks
  `asx.api.markitdigital.com`. The client is written to the shape documented in the brief and
  validates the payload with zod, failing loudly into `ingest_runs.error` if the shape has
  moved. Verify against the real endpoint on first deploy.
- **No ASX public-holiday calendar.** Polling on Australia Day costs one wasted request per
  minute and returns the previous day's list, which dedupes to zero inserts.
- Watchlists, alerts, accounts and payments are deliberately out of scope for v1.

## Verifying before you call it done

Open the ten most recent announcements, generate all ten, and read the output. If the routine
ones are being dressed up as significant, tighten the system prompt in `src/lib/anthropic.ts` —
that failure mode is what makes a screener useless.

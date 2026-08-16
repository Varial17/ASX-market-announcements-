/**
 * ASX Announcement Screener — vanilla TS, no framework.
 *
 * Everything from the API is untrusted issuer text, so the DOM is built with
 * createElement/textContent throughout. There is no innerHTML interpolation in
 * this file, deliberately.
 */

const MARKET_TZ = 'Australia/Sydney';
const POLL_MS = 60_000;
const STALE_MS = 5 * 60 * 1000;

interface FeedItem {
  documentKey: string;
  symbol: string;
  companyName: string;
  headline: string;
  type: string;
  types: string[];
  lodgedAt: string;
  isPriceSensitive: boolean;
  fileSizeKb: number | null;
  sector: string | null;
  industry: string | null;
  ruleFlags: string[];
  analysed: boolean;
  materiality: number | null;
  direction: string | null;
  category: string | null;
}

interface FeedResponse {
  items: FeedItem[];
  nextBefore: string | null;
  lastIngestAt: string | null;
  serverTime: string;
}

type CheckStatus = 'pass' | 'query' | 'fail' | 'not_assessable';

interface ComplianceCheck {
  status: CheckStatus;
  note: string;
  evidence?: string;
}

interface Compliance {
  overall: 'clear' | 'query' | 'reject';
  checks: Record<string, ComplianceCheck>;
}

/** Checklist order and labels — must match src/lib/compliance.ts. */
const CHECK_LABELS: Array<[string, string]> = [
  ['title', 'Title'],
  ['entity', 'Entity & authorisation'],
  ['price_sensitivity', 'Price sensitivity'],
  ['watch_list', 'Watch list'],
  ['inappropriate_content', 'Inappropriate content'],
  ['format', 'Format'],
  ['category', 'Category'],
  ['draft_or_deformity', 'Draft marks / deformity'],
  ['dates_and_numbers', 'Dates & numbers'],
  ['completeness', 'Completeness'],
];

const STATUS_LABELS: Record<CheckStatus, string> = {
  pass: 'PASS',
  query: 'QUERY',
  fail: 'FAIL',
  not_assessable: 'NOT CHECKED',
};

/** Glyphs carry the verdict at a glance; colour alone is not enough. */
const STATUS_GLYPHS: Record<CheckStatus, string> = {
  pass: '✓',
  query: '!',
  fail: '✕',
  not_assessable: '–',
};

const OVERALL_HEADLINES: Record<string, string> = {
  clear: 'PASSED',
  query: 'NEEDS REVIEW',
  reject: 'FAILED',
};

interface Party {
  name: string;
  role: string;
  ticker?: string;
}

interface Analysis {
  category: string;
  direction: string;
  materiality: number;
  confidence: number;
  summary: string;
  whyItMatters: string;
  figures: Array<{ label: string; value: string }>;
  flags: string[];
  sourceQuote: string | null;
  parties?: Party[];
  compliance?: Compliance | null;
  model?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  generatedAt?: string;
}

interface DetailResponse {
  announcement: FeedItem;
  analysis: Analysis | null;
  pdfUrl: string;
}

// ---------------------------------------------------------------- utilities

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const timeFmt = new Intl.DateTimeFormat('en-AU', {
  timeZone: MARKET_TZ,
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

const clockFmt = new Intl.DateTimeFormat('en-AU', {
  timeZone: MARKET_TZ,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Rendered in AEST regardless of where the viewer is. */
function formatTime(iso: string): string {
  return timeFmt.format(new Date(iso));
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: MARKET_TZ,
  weekday: 'short',
  hour: '2-digit',
  hourCycle: 'h23',
});

function isMarketOpen(at = new Date()): boolean {
  const parts = partsFmt.formatToParts(at);
  const weekday = WEEKDAYS[parts.find((p) => p.type === 'weekday')?.value ?? ''] ?? -1;
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '-1');
  return weekday >= 1 && weekday <= 5 && hour >= 7 && hour < 20;
}

function titleCase(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Pull the current value of a string field out of a JSON document that is
 * still being streamed. Returns whatever has arrived so far, so the summary
 * can render character by character instead of appearing all at once.
 */
function partialString(buffer: string, key: string): string | null {
  const marker = `"${key}"`;
  const at = buffer.indexOf(marker);
  if (at === -1) return null;

  let i = at + marker.length;
  while (i < buffer.length && /[\s:]/.test(buffer[i] ?? '')) i++;
  if (buffer[i] !== '"') return null;
  i++;

  const escapes: Record<string, string> = {
    n: '\n',
    t: '\t',
    r: '\r',
    b: '\b',
    f: '\f',
    '"': '"',
    '\\': '\\',
    '/': '/',
  };

  let out = '';
  while (i < buffer.length) {
    const ch = buffer[i] ?? '';
    if (ch === '\\') {
      const next = buffer[i + 1];
      if (next === undefined) break; // escape split across chunks
      if (next === 'u') {
        const hex = buffer.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      out += escapes[next] ?? next;
      i += 2;
      continue;
    }
    if (ch === '"') return out;
    out += ch;
    i++;
  }
  return out;
}

// -------------------------------------------------------------------- state

const state = {
  items: [] as FeedItem[],
  knownKeys: new Set<string>(),
  newKeys: new Set<string>(),
  selected: null as string | null,
  filter: 'all',
  query: '',
  lastIngestAt: null as string | null,
  /** Analyses generated this session, so the list annotates itself instantly. */
  analysedThisSession: new Map<string, number>(),
};

// ------------------------------------------------------------------ element

const rowsEl = document.getElementById('rows') as HTMLOListElement;
const detailEl = document.getElementById('detail') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;
const staleEl = document.getElementById('stale-banner') as HTMLElement;
const searchEl = document.getElementById('search') as HTMLInputElement;
const listFooterEl = document.getElementById('list-footer') as HTMLElement;

// -------------------------------------------------------------------- feed

async function loadFeed(isPoll = false): Promise<void> {
  const params = new URLSearchParams({ limit: '150', filter: state.filter });
  if (state.query) params.set('q', state.query);

  let data: FeedResponse;
  try {
    const res = await fetch(`/api/announcements?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = (await res.json()) as FeedResponse;
  } catch (err) {
    statusEl.textContent = `Feed unavailable — ${err instanceof Error ? err.message : 'error'}`;
    return;
  }

  if (isPoll) {
    state.newKeys.clear();
    for (const item of data.items) {
      if (!state.knownKeys.has(item.documentKey)) state.newKeys.add(item.documentKey);
    }
  }
  for (const item of data.items) state.knownKeys.add(item.documentKey);

  state.items = data.items;
  state.lastIngestAt = data.lastIngestAt;

  renderRows();
  renderStatus();
}

function renderStatus(): void {
  const open = isMarketOpen();
  const parts = [open ? 'Market hours' : 'Outside market hours'];
  if (state.lastIngestAt) {
    parts.push(`updated ${clockFmt.format(new Date(state.lastIngestAt))} AEST`);
  }
  statusEl.textContent = parts.join(' · ');

  // If the data is more than five minutes old during market hours, say so
  // rather than pretending it is current.
  const ageMs = state.lastIngestAt ? Date.now() - new Date(state.lastIngestAt).getTime() : Infinity;
  const stale = open && ageMs > STALE_MS;
  staleEl.hidden = !stale;
  if (stale) {
    const mins = Number.isFinite(ageMs) ? Math.round(ageMs / 60000) : null;
    staleEl.textContent =
      mins === null
        ? 'No successful ingest recorded. This feed is not live.'
        : `Feed has not updated for ${mins} minutes during market hours. This data may not be current.`;
  }
}

function materialityOf(item: FeedItem): number | null {
  return state.analysedThisSession.get(item.documentKey) ?? item.materiality;
}

function renderRows(): void {
  rowsEl.replaceChildren();

  if (state.items.length === 0) {
    listFooterEl.textContent = 'No announcements match.';
    return;
  }

  for (const item of state.items) {
    const li = el('li');
    const btn = el('button', 'row');
    btn.type = 'button';
    if (item.documentKey === state.selected) btn.classList.add('is-selected');
    if (state.newKeys.has(item.documentKey)) btn.classList.add('is-new');

    const top = el('div', 'row-top');
    top.append(el('span', 'code', item.symbol));
    top.append(el('span', 'time', formatTime(item.lodgedAt)));
    if (item.isPriceSensitive) {
      const marker = el('span', 'sensitive', '$');
      marker.title = 'Issuer-flagged price sensitive';
      top.append(marker);
    }
    const mat = materialityOf(item);
    if (mat != null) {
      const badge = el('span', 'mat', `M${mat}`);
      badge.dataset.level = String(mat);
      badge.title = 'Analysed — materiality score';
      top.append(badge);
    }
    btn.append(top);

    btn.append(el('div', 'row-headline', item.headline));

    const meta = el('div', 'row-meta');
    meta.append(el('span', undefined, item.companyName));
    if (item.type) meta.append(el('span', undefined, item.type));
    if (item.fileSizeKb != null) meta.append(el('span', undefined, `${item.fileSizeKb} KB`));
    btn.append(meta);

    btn.addEventListener('click', () => {
      void selectItem(item.documentKey);
    });

    li.append(btn);
    rowsEl.append(li);
  }

  listFooterEl.textContent = `${state.items.length} announcement${
    state.items.length === 1 ? '' : 's'
  }`;
}

// ------------------------------------------------------------------ detail

async function selectItem(documentKey: string): Promise<void> {
  state.selected = documentKey;
  renderRows();

  // Metadata renders immediately from the row we already have; the fetch only
  // fills in the analysis.
  const known = state.items.find((i) => i.documentKey === documentKey);
  if (known) renderDetail({ announcement: known, analysis: null, pdfUrl: pdfUrlFor(documentKey) }, true);

  try {
    const res = await fetch(`/api/announcements/${encodeURIComponent(documentKey)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const detail = (await res.json()) as DetailResponse;
    if (state.selected !== documentKey) return; // user moved on
    renderDetail(detail, false);
  } catch (err) {
    if (state.selected !== documentKey) return;
    const box = el('div', 'card error', `Could not load detail: ${
      err instanceof Error ? err.message : 'error'
    }`);
    detailEl.append(box);
  }
}

function pdfUrlFor(documentKey: string): string {
  return `/api/pdf/${encodeURIComponent(documentKey)}`;
}

function renderDetail(detail: DetailResponse, provisional: boolean): void {
  const { announcement, analysis, pdfUrl } = detail;
  detailEl.replaceChildren();

  // 1. Metadata
  const head = el('div', 'card detail-head');
  const meta = el('div', 'detail-meta');
  meta.append(el('span', 'code', announcement.symbol));
  meta.append(el('span', undefined, announcement.companyName));
  meta.append(el('span', undefined, `${formatTime(announcement.lodgedAt)} AEST`));
  if (announcement.isPriceSensitive) meta.append(el('span', 'sensitive', '$ Price sensitive'));
  head.append(meta);
  head.append(el('h2', undefined, announcement.headline));

  const sub = el('div', 'detail-meta');
  if (announcement.types.length) sub.append(el('span', undefined, announcement.types.join(' · ')));
  if (announcement.fileSizeKb != null) {
    sub.append(el('span', undefined, `${announcement.fileSizeKb} KB`));
  }
  if (announcement.sector) sub.append(el('span', undefined, announcement.sector));
  head.append(sub);
  detailEl.append(head);

  // 2. Analysis slot
  const slot = el('div', 'card');
  slot.id = 'analysis-slot';
  detailEl.append(slot);

  if (analysis) {
    renderAnalysis(slot, analysis, 'Cached');
  } else if (provisional) {
    slot.append(el('div', undefined, 'Loading…'));
  } else {
    renderGenerate(slot, announcement.documentKey);
  }

  // 3. Source document, same-origin so it frames correctly
  const frame = document.createElement('iframe');
  frame.className = 'pdf-frame';
  frame.src = pdfUrl;
  frame.title = `Source document: ${announcement.headline}`;

  const bar = el('div', 'pdf-bar');
  const status = el('span', 'gen-meta');
  const upload = el('button', 'btn-ghost', 'Replace PDF…');
  upload.type = 'button';
  upload.addEventListener('click', () => {
    pickAndUpload(announcement.documentKey, frame, status);
  });
  bar.append(upload, status);

  detailEl.append(bar);
  detailEl.append(frame);
}

const TOKEN_KEY = 'asx.uploadToken';

/**
 * Upload a PDF for documents the poller cannot reach — test fixtures, or
 * sources behind bot protection that return a challenge page to a plain fetch.
 */
function pickAndUpload(documentKey: string, frame: HTMLIFrameElement, status: HTMLElement): void {
  let token = window.localStorage.getItem(TOKEN_KEY);
  if (!token) {
    token = window.prompt('Upload token (the UPLOAD_TOKEN secret):');
    if (!token) return;
    window.localStorage.setItem(TOKEN_KEY, token);
  }

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/pdf,.pdf';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    void send(file);
  });
  input.click();

  async function send(file: File): Promise<void> {
    status.textContent = `Uploading ${(file.size / 1024 / 1024).toFixed(1)}MB…`;
    try {
      const res = await fetch(`/api/pdf/${encodeURIComponent(documentKey)}`, {
        method: 'PUT',
        headers: { 'X-Upload-Token': token ?? '', 'Content-Type': 'application/pdf' },
        body: file,
      });
      const body = (await res.json()) as { message?: string; error?: string; bytes?: number };
      if (!res.ok) {
        // A stale token is the likeliest failure; drop it so the next attempt re-prompts.
        if (res.status === 401) window.localStorage.removeItem(TOKEN_KEY);
        throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      }
      status.textContent = `Uploaded ${((body.bytes ?? 0) / 1024 / 1024).toFixed(1)}MB`;
      // Cache-bust the frame: the browser caches /api/pdf/:key, so without a
      // changing query string it would keep showing the previous document.
      frame.src = `/api/pdf/${encodeURIComponent(documentKey)}?t=${Date.now()}`;
    } catch (err) {
      status.textContent = `Upload failed: ${err instanceof Error ? err.message : 'error'}`;
    }
  }
}

function renderGenerate(slot: HTMLElement, documentKey: string): void {
  slot.replaceChildren();
  const headRow = el('div', 'analysis-head');
  headRow.append(el('h3', undefined, 'AI analysis'));
  const btn = el('button', 'btn', 'Generate analysis');
  btn.type = 'button';
  btn.addEventListener('click', () => {
    void generate(slot, documentKey, btn);
  });
  headRow.append(btn);
  slot.append(headRow);
  slot.append(
    el(
      'div',
      undefined,
      'Not yet analysed. Generating costs a few cents once; the result is then cached for everyone.',
    ),
  );
}

function renderAnalysis(slot: HTMLElement, analysis: Analysis, provenance: string): void {
  slot.replaceChildren();

  const headRow = el('div', 'analysis-head');
  headRow.append(el('h3', undefined, 'AI analysis'));
  headRow.append(el('span', 'gen-meta', provenance));
  slot.append(headRow);

  const badges = el('div', 'badges');
  const mat = el('span', 'mat', `Materiality ${analysis.materiality}/5`);
  mat.dataset.level = String(analysis.materiality);
  badges.append(mat);
  badges.append(el('span', `badge ${analysis.direction}`, titleCase(analysis.direction)));
  badges.append(el('span', 'badge', titleCase(analysis.category)));
  badges.append(el('span', 'badge', `Confidence ${Math.round(analysis.confidence * 100)}%`));
  for (const flag of analysis.flags) badges.append(el('span', 'badge', titleCase(flag)));
  slot.append(badges);

  slot.append(el('p', 'summary', analysis.summary));
  slot.append(el('p', 'why', analysis.whyItMatters));

  if (analysis.figures.length) {
    const dl = el('dl', 'figures');
    for (const figure of analysis.figures) {
      const wrap = el('div', 'figure');
      wrap.append(el('dt', undefined, figure.label));
      wrap.append(el('dd', undefined, figure.value));
      dl.append(wrap);
    }
    slot.append(dl);
  }

  if (analysis.parties?.length) {
    slot.append(el('h4', 'sub-head', 'Parties'));
    const table = el('table', 'parties');
    for (const party of analysis.parties) {
      const tr = el('tr');
      const nameCell = el('td', 'party-name');
      nameCell.append(el('span', undefined, party.name));
      // Only rendered when the document actually stated a code — the prompt
      // forbids supplying one from the model's own knowledge.
      if (party.ticker) nameCell.append(el('span', 'party-ticker', party.ticker));
      tr.append(nameCell);
      tr.append(el('td', 'party-role', party.role));
      table.append(tr);
    }
    slot.append(table);
  }

  if (analysis.sourceQuote) {
    slot.append(el('blockquote', 'quote', `“${analysis.sourceQuote}”`));
  }

  const bits: string[] = [];
  if (analysis.model) bits.push(analysis.model);
  if (analysis.inputTokens != null && analysis.outputTokens != null) {
    bits.push(`${analysis.inputTokens} in / ${analysis.outputTokens} out tokens`);
  }
  if (bits.length) slot.append(el('div', 'gen-meta', bits.join(' · ')));

  renderCompliance(slot, analysis.compliance ?? null);
}

/** The ASX announcement review checklist, rendered under the investor analysis. */
function renderCompliance(slot: HTMLElement, compliance: Compliance | null): void {
  const wrap = el('div', 'compliance');

  const head = el('div', 'analysis-head');
  head.append(el('h3', undefined, 'Announcement review'));
  slot.append(el('hr', 'rule'));

  if (!compliance) {
    // Generated before the checklist existed. Say so rather than showing ten
    // blank rows, which would read as ten silent passes.
    head.append(el('span', 'gen-meta', 'not run'));
    wrap.append(head);
    wrap.append(
      el(
        'p',
        'muted-note',
        'This analysis predates the review checklist. Re-generate to add it.',
      ),
    );
    slot.append(wrap);
    return;
  }

  wrap.append(head);

  const counts = CHECK_LABELS.reduce<Record<string, number>>((acc, [id]) => {
    const status = compliance.checks[id]?.status;
    if (status) acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});
  const passed = counts['pass'] ?? 0;
  const attention = CHECK_LABELS.filter(([id]) => {
    const s = compliance.checks[id]?.status;
    return s === 'query' || s === 'fail';
  });

  // One unmissable line: did it pass, and if not, exactly which checks didn't.
  const banner = el('div', 'verdict-banner');
  banner.dataset.overall = compliance.overall;
  banner.append(
    el('span', 'verdict-glyph', compliance.overall === 'clear' ? '✓' : compliance.overall === 'reject' ? '✕' : '!'),
  );
  const text = el('div', 'verdict-text');
  text.append(
    el('div', 'verdict-headline', OVERALL_HEADLINES[compliance.overall] ?? compliance.overall),
  );
  text.append(
    el(
      'div',
      'verdict-sub',
      attention.length
        ? `${passed}/${CHECK_LABELS.length} passed · needs attention: ${attention
            .map(([, label]) => label)
            .join(', ')}`
        : `${passed}/${CHECK_LABELS.length} checks passed${
            counts['not_assessable'] ? ` · ${counts['not_assessable']} not checked` : ''
          }`,
    ),
  );
  banner.append(text);
  wrap.append(banner);

  const list = el('ol', 'checks');
  for (const [id, label] of CHECK_LABELS) {
    const check = compliance.checks[id];
    const status: CheckStatus = check?.status ?? 'not_assessable';
    const li = el('li', 'check');
    li.dataset.status = status;

    const row = el('div', 'check-head');
    const glyph = el('span', 'check-glyph', STATUS_GLYPHS[status]);
    glyph.dataset.status = status;
    // Screen readers get the word, not the symbol.
    glyph.setAttribute('aria-label', STATUS_LABELS[status]);
    row.append(glyph);
    row.append(el('span', 'check-label', label));
    const pill = el('span', 'check-status', STATUS_LABELS[status]);
    pill.dataset.status = status;
    row.append(pill);
    li.append(row);

    li.append(el('p', 'check-note', check?.note ?? 'No result returned for this check.'));
    if (check?.evidence) li.append(el('blockquote', 'quote', `“${check.evidence}”`));

    list.append(li);
  }
  wrap.append(list);

  wrap.append(
    el(
      'p',
      'muted-note',
      'First-pass review to assist a human reviewer. Not a determination by ASX and not a legal opinion. "Not assessable" means the check could not be made from the lodged document — it is not a pass.',
    ),
  );
  slot.append(wrap);
}

// --------------------------------------------------------------- generation

async function generate(
  slot: HTMLElement,
  documentKey: string,
  button: HTMLButtonElement,
): Promise<void> {
  button.disabled = true;
  button.textContent = 'Analysing…';

  // Progressive view while the tool-call JSON streams in.
  const live = el('div');
  const liveSummary = el('p', 'summary', 'Reading the document…');
  const liveWhy = el('p', 'why');
  live.append(liveSummary, liveWhy);
  slot.append(live);

  try {
    const res = await fetch(`/api/announcements/${encodeURIComponent(documentKey)}/analyse`, {
      method: 'POST',
    });

    // A cached analysis comes back as plain JSON, not a stream.
    if (res.headers.get('content-type')?.includes('application/json')) {
      const body = (await res.json()) as { analysis?: Analysis; message?: string };
      if (!res.ok || !body.analysis) {
        throw new Error(body.message ?? `HTTP ${res.status}`);
      }
      renderAnalysis(slot, body.analysis, 'Cached');
      return;
    }

    if (!res.body) throw new Error('No response body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let jsonBuffer = '';
    let finalAnalysis: Analysis | null = null;
    let failure: string | null = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });

      const frames = sseBuffer.split('\n\n');
      sseBuffer = frames.pop() ?? '';

      for (const frame of frames) {
        const eventLine = frame.split('\n').find((l) => l.startsWith('event: '));
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!eventLine || !dataLine) continue;

        const event = eventLine.slice(7).trim();
        let payload: unknown;
        try {
          payload = JSON.parse(dataLine.slice(6));
        } catch {
          continue;
        }

        if (event === 'delta') {
          jsonBuffer += (payload as { json: string }).json;
          const summary = partialString(jsonBuffer, 'summary');
          if (summary) liveSummary.textContent = summary;
          const why = partialString(jsonBuffer, 'why_it_matters');
          if (why) liveWhy.textContent = why;
        } else if (event === 'result') {
          const data = payload as {
            analysis: {
              category: string;
              direction: string;
              materiality: number;
              confidence: number;
              summary: string;
              why_it_matters: string;
              figures: Array<{ label: string; value: string }>;
              flags: string[];
              source_quote?: string;
              parties?: Party[];
              compliance?: Compliance;
            };
            model: string;
            inputTokens: number | null;
            outputTokens: number | null;
          };
          finalAnalysis = {
            category: data.analysis.category,
            direction: data.analysis.direction,
            materiality: data.analysis.materiality,
            confidence: data.analysis.confidence,
            summary: data.analysis.summary,
            whyItMatters: data.analysis.why_it_matters,
            figures: data.analysis.figures,
            flags: data.analysis.flags,
            sourceQuote: data.analysis.source_quote ?? null,
            parties: data.analysis.parties ?? [],
            compliance: data.analysis.compliance ?? null,
            model: data.model,
            inputTokens: data.inputTokens,
            outputTokens: data.outputTokens,
          };
        } else if (event === 'error') {
          failure = (payload as { message: string }).message;
        }
      }
    }

    if (failure) throw new Error(failure);
    if (!finalAnalysis) throw new Error('Stream ended without a result');

    renderAnalysis(slot, finalAnalysis, 'Generated just now');
    state.analysedThisSession.set(documentKey, finalAnalysis.materiality);
    renderRows();
  } catch (err) {
    slot.replaceChildren();
    const headRow = el('div', 'analysis-head');
    headRow.append(el('h3', undefined, 'AI analysis'));
    slot.append(headRow);
    slot.append(
      el('p', 'error', `Analysis failed: ${err instanceof Error ? err.message : 'unknown error'}`),
    );
    const retry = el('button', 'btn', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', () => {
      renderGenerate(slot, documentKey);
    });
    slot.append(retry);
  }
}

// -------------------------------------------------------------------- wiring

for (const chip of document.querySelectorAll<HTMLButtonElement>('.chip')) {
  chip.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.chip')) other.classList.remove('is-active');
    chip.classList.add('is-active');
    state.filter = chip.dataset.filter ?? 'all';
    void loadFeed();
  });
}

let searchTimer: number | undefined;
searchEl.addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    state.query = searchEl.value.trim();
    void loadFeed();
  }, 200);
});

void loadFeed();
window.setInterval(() => {
  void loadFeed(true);
}, POLL_MS);
// Keep the "updated N ago" line and the staleness banner honest between polls.
window.setInterval(renderStatus, 30_000);

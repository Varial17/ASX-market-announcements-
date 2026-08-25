-- migrations/0001_init.sql

CREATE TABLE announcements (
  document_key      TEXT PRIMARY KEY,
  symbol            TEXT NOT NULL,
  company_name      TEXT NOT NULL,
  headline          TEXT NOT NULL,
  announcement_type TEXT NOT NULL,           -- primary type (element 0)
  types_json        TEXT NOT NULL,           -- full array as JSON
  lodged_at         TEXT NOT NULL,           -- ISO 8601 UTC
  is_price_sensitive INTEGER NOT NULL DEFAULT 0,
  file_size_kb      INTEGER,
  isin              TEXT,
  sector            TEXT,
  industry          TEXT,
  pdf_r2_key        TEXT,                    -- null until first fetched
  first_seen_at     TEXT NOT NULL,
  -- Deterministic rules-engine output, written at ingest (see src/lib/rules.ts).
  rule_floor        INTEGER,                 -- materiality floor, 1..5
  rule_ceiling      INTEGER,                 -- materiality ceiling, 1..5
  rule_flags_json   TEXT                     -- ["always_material", ...]
);

CREATE INDEX idx_ann_lodged   ON announcements(lodged_at DESC);
CREATE INDEX idx_ann_symbol   ON announcements(symbol, lodged_at DESC);
CREATE INDEX idx_ann_ps       ON announcements(is_price_sensitive, lodged_at DESC);

CREATE TABLE analyses (
  document_key   TEXT PRIMARY KEY REFERENCES announcements(document_key),
  category       TEXT NOT NULL,
  direction      TEXT NOT NULL,              -- positive | negative | neutral
  materiality    INTEGER NOT NULL,           -- 1..5
  confidence     REAL NOT NULL,              -- 0..1
  summary        TEXT NOT NULL,
  why_it_matters TEXT NOT NULL,
  figures_json   TEXT NOT NULL,              -- [{label,value}]
  flags_json     TEXT NOT NULL,              -- ["dilutive", ...]
  source_quote   TEXT,
  model          TEXT NOT NULL,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  generated_at   TEXT NOT NULL
);

CREATE INDEX idx_an_mat ON analyses(materiality DESC);

CREATE TABLE ingest_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at      TEXT NOT NULL,
  fetched     INTEGER NOT NULL,
  inserted    INTEGER NOT NULL,
  error       TEXT
);

-- /api/health asks "when did ingestion last succeed?" — that is an index scan
-- over recent rows, not a full table scan.
CREATE INDEX idx_runs_ran_at ON ingest_runs(ran_at DESC);

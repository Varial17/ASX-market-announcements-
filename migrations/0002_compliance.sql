-- migrations/0002_compliance.sql
--
-- Adds the ASX announcement review checklist alongside the investor analysis.
-- Existing rows keep their analysis and read back with compliance = null, so
-- the UI offers to re-run them rather than showing an empty checklist.

ALTER TABLE analyses ADD COLUMN compliance_overall TEXT;   -- clear | query | reject
ALTER TABLE analyses ADD COLUMN compliance_json    TEXT;   -- full ten-check object

-- "Show me everything a human still needs to look at" is the main review
-- workflow, so it gets an index.
CREATE INDEX idx_an_compliance ON analyses(compliance_overall, generated_at DESC);

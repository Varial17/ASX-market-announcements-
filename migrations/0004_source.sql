-- migrations/0004_source.sql
--
-- Where a row came from. Manually uploaded documents are not part of the ASX
-- feed and should be findable separately — a test fixture is otherwise buried
-- among hundreds of real lodgements.

ALTER TABLE announcements ADD COLUMN source TEXT NOT NULL DEFAULT 'asx';  -- asx | upload

CREATE INDEX idx_ann_source ON announcements(source, lodged_at DESC);

-- Rows created by the upload endpoint before this column existed used a TEST-
-- prefix by convention. Real ASX document keys always start with digits, so
-- this cannot catch a genuine lodgement.
UPDATE announcements SET source = 'upload' WHERE document_key LIKE 'TEST-%';

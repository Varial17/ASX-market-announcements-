-- migrations/0003_parties.sql
--
-- Parties to the transaction: legal entity names and, where the document states
-- them, ticker codes. Existing rows read back with an empty list.

ALTER TABLE analyses ADD COLUMN parties_json TEXT;

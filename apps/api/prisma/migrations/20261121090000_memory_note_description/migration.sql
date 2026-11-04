-- US-001: a NOTE memory item stores its index line in `description`.
--
-- A note is a `MemoryItem` with `kind = 'NOTE'`: `subject` is the slug, `predicate` the type, `object` the
-- Markdown body and `description` the one line nax's memory index shows. The triple kinds
-- (FACT, DECISION, PREFERENCE, CONSTRAINT, INCIDENT_PATTERN) keep null here, so the column is nullable and
-- every existing row is unchanged.
--
-- No index: `description` is read with the row it belongs to (US-003 adds the full-text vector that makes it
-- searchable) and nothing filters or joins on it.

ALTER TABLE "MemoryItem" ADD COLUMN "description" TEXT;

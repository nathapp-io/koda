-- memory-notes US-003 (#377): full-text search over a memory item.
--
-- `searchVector` is a generated column over every user-written text field of the row, so the English
-- parser stamps subject, predicate, description (a NOTE's index line, US-001) and object into one tsvector
-- when the row is written — no trigger, no backfill, and no writer can forget it. The GIN index is what
-- makes `"searchVector" @@ websearch_to_tsquery('english', $1)` an index scan instead of a Seq Scan.
--
-- The schema declares the column as `Unsupported("tsvector")?` on purpose: Prisma cannot model a tsvector,
-- and declaring it keeps `prisma migrate`/`db push` from proposing to drop a column this migration creates.
--
-- Written by hand, and shipped verbatim by `test/helpers/memory-search-vector.ts` (replayed after
-- `prisma db push` in test/global-setup.ts, because db push cannot express a generated column). The two
-- GIN/column statements below must stay character-for-character identical to that helper; the drop that
-- helper leads with is test-only and never shipped here.

ALTER TABLE "MemoryItem" ADD COLUMN IF NOT EXISTS "searchVector" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("subject", '') || ' ' || coalesce("predicate", '') || ' ' || coalesce("description", '') || ' ' || coalesce("object", ''))) STORED;
CREATE INDEX IF NOT EXISTS "MemoryItem_searchVector_idx" ON "MemoryItem" USING GIN ("searchVector");

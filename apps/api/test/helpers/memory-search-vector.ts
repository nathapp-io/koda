/**
 * The generated `searchVector` column of `MemoryItem`, as the test schema needs it (memory-notes US-003).
 *
 * Every DB-mode spec builds its schema with `prisma db push --force-reset` (`test/global-setup.ts`), and
 * `db push` cannot express `GENERATED ALWAYS AS … STORED`: it creates a plain `tsvector` that nothing ever
 * fills, so every full-text query would answer nothing and the ranked path would fall back to `contains`
 * for every test. `globalSetup` replays these statements right after the push, next to
 * `PARTIAL_UNIQUE_INDEXES`, so the test schema has the same generated column and GIN index the migration
 * ships. `src/memory/memory-search-vector.spec.ts` pins every statement except the drop to that migration.
 *
 * The index name is Prisma's own default for `@@index([searchVector], type: Gin)`, so a schema pushed with
 * the index already in place and a schema built by this replay cannot hold two differently named copies.
 */
export const MEMORY_SEARCH_VECTOR_STATEMENTS: readonly string[] = [
  `ALTER TABLE "MemoryItem" DROP COLUMN IF EXISTS "searchVector"`,
  `ALTER TABLE "MemoryItem" ADD COLUMN IF NOT EXISTS "searchVector" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("subject", '') || ' ' || coalesce("predicate", '') || ' ' || coalesce("description", '') || ' ' || coalesce("object", ''))) STORED`,
  `CREATE INDEX IF NOT EXISTS "MemoryItem_searchVector_idx" ON "MemoryItem" USING GIN ("searchVector")`,
];

/**
 * memory-notes US-003 — the trusted test schema for the generated `searchVector` column.
 *
 * Every DB-mode spec builds its schema with `prisma db push --force-reset` (`test/global-setup.ts`), and
 * `db push` cannot express `GENERATED ALWAYS AS … STORED`: it would create a plain, never-filled `tsvector`
 * and every full-text query would answer nothing. `test/helpers/memory-search-vector.ts` therefore holds the
 * statements that turn the pushed column into the generated one, `global-setup.ts` replays them next to
 * `PARTIAL_UNIQUE_INDEXES`, and this spec pins each of them to the migration production runs — the test
 * schema and the deployed schema cannot drift.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { MEMORY_SEARCH_VECTOR_STATEMENTS } from '../../test/helpers/memory-search-vector';

const MIGRATIONS_DIR = join(__dirname, '../../prisma/migrations');

/** Every committed migration's SQL, in one string: a statement is "shipped" when it is a substring of it. */
const shippedSql = readdirSync(MIGRATIONS_DIR)
  .filter((name) => /^\d{14}_/.test(name))
  .sort()
  .map((name) => readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'))
  .join('\n');

describe('memory full-text search schema (memory-notes US-003)', () => {
  // The drop is the test-only statement: `db push` made the plain column this replay replaces, and no
  // migration may ship a drop of the column the same migration creates.
  const [drop, ...shipped] = MEMORY_SEARCH_VECTOR_STATEMENTS;

  it('AC-14: drops the plain column `db push` creates before adding the generated one', () => {
    expect(drop).toBe('ALTER TABLE "MemoryItem" DROP COLUMN IF EXISTS "searchVector"');
  });

  it.each(shipped.map((statement) => [statement]))('AC-14: is shipped verbatim by a migration: %s', (statement) => {
    expect(shippedSql).toContain(statement);
  });

  it('AC-14: no migration drops the column the replay creates', () => {
    expect(shippedSql).not.toContain(drop);
  });

  it('declares the column as Unsupported tsvector with its GIN index, so Prisma never drops it', () => {
    const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');
    const model = schema.match(/model MemoryItem \{([\s\S]*?)\n\}/)?.[1];

    expect(model).toContain('searchVector Unsupported("tsvector")?');
    expect(model).toContain('@@index([searchVector], type: Gin)');
  });

  it('is replayed by the DB-mode global setup, next to the partial indexes', () => {
    // The helper only matters if `db push` is followed by it: without the replay the pushed column stays the
    // plain, never-filled tsvector it replaces.
    const setup = readFileSync(join(__dirname, '../../test/global-setup.ts'), 'utf8');

    expect(setup).toContain("from './helpers/memory-search-vector'");
    expect(setup).toContain('for (const statement of MEMORY_SEARCH_VECTOR_STATEMENTS)');
  });
});

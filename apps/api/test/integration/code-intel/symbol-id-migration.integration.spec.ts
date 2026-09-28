/**
 * Track 3 Slice 4 (M13): the migration deletes every symbol row (derived data,
 * rebuilt on the next index) rather than rewriting ids embedded in the caller/callee JSON.
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/code-intel/symbol-id-migration.integration.spec.ts
 */
import { applyMigration, scratchSchemaBefore, ScratchSchema } from '../../helpers/migration-schema';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const TARGET = '20260929090100_symbol_project_scoped_ids';

describeIntegration('symbol id migration (M13)', () => {
  jest.setTimeout(60000);
  let scratch: ScratchSchema;

  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'symbol_id_migration', TARGET);
    await scratch.db.$executeRawUnsafe(
      `INSERT INTO "Project" ("id", "name", "slug", "key", "updatedAt") VALUES ('p1', 'P', 'p', 'PP', CURRENT_TIMESTAMP)`,
    );
    await scratch.db.$executeRawUnsafe(`
      INSERT INTO "Symbol" ("id", "symbolId", "projectId", "repoId", "commitHash", "name", "kind", "file", "startLine", "endLine", "updatedAt")
      VALUES ('acme/widgets:src/a.ts::alpha', 'acme/widgets:src/a.ts::alpha', 'p1', 'acme/widgets', 'c1', 'alpha', 'function', 'src/a.ts', 1, 2, CURRENT_TIMESTAMP)
    `);
    await applyMigration(scratch.db, TARGET);
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('leaves no legacy symbol rows', async () => {
    const [{ count }] = await scratch.db.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT COUNT(*)::bigint AS count FROM "Symbol"`);
    expect(Number(count)).toBe(0);
  });
});

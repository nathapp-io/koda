import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet S5b 1d US-001 AC-12 (PG): applying 20261022090000_chat_thread_workspace to the schema every earlier
 * migration builds creates `ChatThread_createdById_kind_lastActivityAt_idx` on `ChatThread` over
 * (createdById, kind, lastActivityAt) in that order, and the index does not exist before it runs.
 *
 * The schema is a throwaway schema inside the test database: `prisma db push` never runs migrations, so this is the
 * only place the committed SQL is executed. The database-free half of AC-12 lives in
 * test/unit/fleet/chat-thread-workspace-migration.spec.ts.
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/fleet-thread-workspace-migration.integration.spec.ts
 */
import { PrismaClient } from '../../../src/generated/prisma/client';
import { applyMigration, migrationsBefore, scratchSchemaBefore, ScratchSchema } from '../../helpers/migration-schema';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
const MIGRATION = '20261022090000_chat_thread_workspace';
const INDEX = 'ChatThread_createdById_kind_lastActivityAt_idx';
const SCHEMA = 'chat_thread_workspace_mig';
vi.setConfig({ testTimeout: 60_000 });

/** The index definitions named `ChatThread_createdById_kind_lastActivityAt_idx` in the scratch schema. */
async function indexDefs(db: PrismaClient): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<Array<{ indexdef: string }>>(
    `SELECT "indexdef" FROM pg_indexes WHERE schemaname = '${SCHEMA}' AND indexname = '${INDEX}'`,
  );
  return rows.map((row) => row.indexdef);
}

/** The quoted column list of an index definition, in index order. */
function columnsOf(indexDef: string): string[] {
  return (indexDef.match(/\(([^()]*)\)/)?.[1] ?? '')
    .split(',')
    .map((column) => column.trim().replace(/"/g, ''))
    .filter((column) => column.length > 0);
}

describeIntegration('fleet ChatThread workspace migration (PG, US-001 AC-12)', () => {
  let scratch: ScratchSchema;
  let before: string[] = [];
  let after: string[] = [];

  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, SCHEMA, MIGRATION);
    before = await indexDefs(scratch.db);
    await applyMigration(scratch.db, MIGRATION);
    after = await indexDefs(scratch.db);
  }, 120_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  it('AC-12: the index does not exist in the schema built by the migrations before it', () => {
    // The chain must really have run, or "no index" would be true of an empty schema.
    expect(migrationsBefore(MIGRATION).length).toBeGreaterThan(0);
    expect(before).toEqual([]);
  });

  it('AC-12: applying the migration creates ChatThread_createdById_kind_lastActivityAt_idx on ChatThread', () => {
    expect(after).toHaveLength(1);
    expect(after[0]).toMatch(/CREATE INDEX "ChatThread_createdById_kind_lastActivityAt_idx"/);
    expect(after[0]).toMatch(/ON\s+(?:\S+\.)?"ChatThread"/);
  });

  it('AC-12: the index covers createdById, kind and lastActivityAt in that order', () => {
    expect(columnsOf(after[0] ?? '')).toEqual(['createdById', 'kind', 'lastActivityAt']);
  });
});

import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet AGENT job US-003 AC-10 (PG): applying 20261127090000_fleet_job_agent over the schema every earlier migration
 * builds adds two nullable jsonb columns, and the FleetJob row written before the migration reads null for both.
 *
 * The schema is a throwaway schema inside the test database: `prisma db push` never runs migrations, so this is the
 * only place the committed SQL is executed.
 * Run: cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 bunx vitest run test/integration/fleet/fleet-job-agent-migration.integration.spec.ts
 */
import { applyMigration, migrationsBefore, scratchSchemaBefore, ScratchSchema } from '../../helpers/migration-schema';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
const MIGRATION = '20261127090000_fleet_job_agent';
const SCHEMA = 'fleet_job_agent_mig';
vi.setConfig({ testTimeout: 60_000 });

interface ColumnRow { column_name: string; is_nullable: 'YES' | 'NO'; data_type: string }
interface StoredRow { agentInput: string | null; agentResult: string | null }

const AGENT_COLUMNS = ['agentInput', 'agentResult'];

describeIntegration('fleet job agent columns migration (PG, US-003 AC-10)', () => {
  let scratch: ScratchSchema;
  let before: ColumnRow[] = [];
  let after: ColumnRow[] = [];

  /** The FleetJob columns this story adds, in name order, whatever the schema at that point holds. */
  const agentColumns = (columns: ColumnRow[]): ColumnRow[] =>
    columns.filter((c) => AGENT_COLUMNS.includes(c.column_name)).sort((a, b) => a.column_name.localeCompare(b.column_name));

  const readColumns = async (): Promise<ColumnRow[]> => scratch.db.$queryRawUnsafe<ColumnRow[]>(
    `SELECT column_name, is_nullable, data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'FleetJob'`,
  );

  /** A Project -> FleetRepo -> FleetJob chain written with the columns every earlier migration requires. */
  const insertJob = async (id: string): Promise<void> => {
    await scratch.db.$executeRawUnsafe(
      `INSERT INTO "Project" ("id", "name", "slug", "key", "updatedAt") VALUES ('p-${id}', 'p-${id}', 'slug-${id}', '${id}', now())`,
    );
    await scratch.db.$executeRawUnsafe(
      `INSERT INTO "FleetRepo" ("id", "projectId", "provider", "owner", "name", "defaultBranch", "createdById")
       VALUES ('r-${id}', 'p-${id}', 'github', 'acme', 'app-${id}', 'main', 'u1')`,
    );
    await scratch.db.$executeRawUnsafe(
      `INSERT INTO "FleetJob" ("id", "projectId", "repoId", "ref", "command", "feature", "profiles", "maxCostUsd",
                               "selectorLabels", "requestedById", "updatedAt")
       VALUES ('${id}', 'p-${id}', 'r-${id}', 'main', 'RUN', 'flow-${id}', '{}', 5, '{}', 'u1', now())`,
    );
  };

  /** The stored text of both columns for its own row: SQL NULL answers null, a JSON null would answer 'null'. */
  const stored = async (id: string): Promise<StoredRow[]> =>
    scratch.db.$queryRawUnsafe<StoredRow[]>(
      `SELECT "agentInput"::text AS "agentInput", "agentResult"::text AS "agentResult"
         FROM "FleetJob" WHERE "id" = '${id}'`,
    );

  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, SCHEMA, MIGRATION);
    before = await readColumns();
    // The row the AC is about: written by the schema that preceded the migration.
    await insertJob('job-existing');
    await applyMigration(scratch.db, MIGRATION);
    after = await readColumns();
  }, 120_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  it('AC-10: neither column exists in the schema built by the migrations before it', () => {
    // The chain must really have run, or "no column" would be true of an empty schema.
    expect(migrationsBefore(MIGRATION).length).toBeGreaterThan(0);
    expect(before.map((c) => c.column_name)).toContain('configResult');
    expect(agentColumns(before)).toEqual([]);
  });

  it('AC-10: applying the migration adds two nullable jsonb columns', () => {
    expect(agentColumns(after)).toEqual([
      { column_name: 'agentInput', is_nullable: 'YES', data_type: 'jsonb' },
      { column_name: 'agentResult', is_nullable: 'YES', data_type: 'jsonb' },
    ]);
  });

  it('AC-10: the job that existed before the migration reads null for both columns', async () => {
    expect(await stored('job-existing')).toEqual([{ agentInput: null, agentResult: null }]);
    // The row itself is untouched: the migration only adds columns.
    expect(await scratch.db.$queryRawUnsafe<Array<{ feature: string }>>(
      `SELECT "feature" FROM "FleetJob" WHERE "id" = 'job-existing'`,
    )).toEqual([{ feature: 'flow-job-existing' }]);
  });

  it('AC-10: the columns store agent JSON once the migration ran', async () => {
    await insertJob('job-agent');
    await scratch.db.$executeRawUnsafe(
      `UPDATE "FleetJob"
          SET "agentInput" = '{"name":"spec-reviewer","task":"x"}'::jsonb,
              "agentResult" = '{"status":"completed"}'::jsonb
        WHERE "id" = 'job-agent'`,
    );
    // Parsed rather than compared as text: jsonb rendering is Postgres' business, the value is ours.
    expect((await stored('job-agent')).map((row) => ({
      agentInput: row.agentInput === null ? null : JSON.parse(row.agentInput),
      agentResult: row.agentResult === null ? null : JSON.parse(row.agentResult),
    }))).toEqual([{ agentInput: { name: 'spec-reviewer', task: 'x' }, agentResult: { status: 'completed' } }]);
  });
});
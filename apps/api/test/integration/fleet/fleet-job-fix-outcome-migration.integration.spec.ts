import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet PR-fix US-004 AC-1 (PG): applying 20261118090000_fleet_job_fix_outcome to the schema every earlier migration
 * builds adds a nullable `FleetJob.fixOutcome` column that reads null for a row written without it.
 *
 * The schema is a throwaway schema inside the test database: `prisma db push` never runs migrations, so this is the
 * only place the committed SQL is executed.
 * Run: cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 bunx vitest run test/integration/fleet/fleet-job-fix-outcome-migration.integration.spec.ts
 */
import { applyMigration, migrationsBefore, scratchSchemaBefore, ScratchSchema } from '../../helpers/migration-schema';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
const MIGRATION = '20261118090000_fleet_job_fix_outcome';
const SCHEMA = 'fleet_job_fix_outcome_mig';
vi.setConfig({ testTimeout: 60_000 });

interface ColumnRow { column_name: string; is_nullable: 'YES' | 'NO'; data_type: string }

describeIntegration('fleet job fixOutcome migration (PG, US-004 AC-1)', () => {
  let scratch: ScratchSchema;
  let before: ColumnRow[] = [];
  let after: ColumnRow[] = [];

  const column = (columns: ColumnRow[]) => columns.find((c) => c.column_name === 'fixOutcome');

  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, SCHEMA, MIGRATION);
    before = await scratch.db.$queryRawUnsafe<ColumnRow[]>(
      `SELECT column_name, is_nullable, data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'FleetJob'`,
    );
    await applyMigration(scratch.db, MIGRATION);
    after = await scratch.db.$queryRawUnsafe<ColumnRow[]>(
      `SELECT column_name, is_nullable, data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'FleetJob'`,
    );
  }, 120_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  /** A Project -> FleetRepo -> FleetJob chain of its own, written with the columns every earlier migration requires. */
  const insertJob = async (id: string): Promise<{ fixOutcome: string | null }> => {
    await scratch.db.$executeRawUnsafe(
      `INSERT INTO "Project" ("id", "name", "slug", "key", "updatedAt") VALUES ('p-${id}', 'p-${id}', 'slug-${id}', '${id}', now())`,
    );
    await scratch.db.$executeRawUnsafe(
      `INSERT INTO "FleetRepo" ("id", "projectId", "provider", "owner", "name", "defaultBranch", "createdById")
       VALUES ('r-${id}', 'p-${id}', 'github', 'acme', 'app-${id}', 'main', 'u1')`,
    );
    const rows = await scratch.db.$queryRawUnsafe<Array<{ fixOutcome: string | null }>>(
      `INSERT INTO "FleetJob" ("id", "projectId", "repoId", "ref", "command", "feature", "profiles", "maxCostUsd",
                               "selectorLabels", "requestedById", "updatedAt")
       VALUES ('${id}', 'p-${id}', 'r-${id}', 'main', 'FIX', 'review-pr-7', '{}', 5, '{}', 'u1', now())
       RETURNING "fixOutcome"`,
    );
    return rows[0];
  };

  /** The stored value of its own row, read straight from the column (never another test's row). */
  const storedOutcome = async (id: string): Promise<Array<{ value: string | null }>> =>
    scratch.db.$queryRawUnsafe<Array<{ value: string | null }>>(
      `SELECT "fixOutcome" AS "value" FROM "FleetJob" WHERE "id" = '${id}'`,
    );

  it('AC-1: the column does not exist in the schema built by the migrations before it', () => {
    // The chain must really have run, or "no column" would be true of an empty schema.
    expect(migrationsBefore(MIGRATION).length).toBeGreaterThan(0);
    expect(before.map((c) => c.column_name)).toContain('wipPush');
    expect(column(before)).toBeUndefined();
  });

  it('AC-1: applying the migration adds a nullable text fixOutcome column', () => {
    expect(column(after)).toEqual({ column_name: 'fixOutcome', is_nullable: 'YES', data_type: 'text' });
  });

  it('AC-1: a job inserted without the column reads null', async () => {
    const inserted = await insertJob('job-null');
    expect(inserted).toEqual({ fixOutcome: null });
    expect(await storedOutcome('job-null')).toEqual([{ value: null }]);
  });

  it('AC-1: the column also stores an outcome the runner reported', async () => {
    await insertJob('job-pushed');
    await scratch.db.$executeRawUnsafe(`UPDATE "FleetJob" SET "fixOutcome" = 'pushed' WHERE "id" = 'job-pushed'`);
    expect(await storedOutcome('job-pushed')).toEqual([{ value: 'pushed' }]);
  });
});

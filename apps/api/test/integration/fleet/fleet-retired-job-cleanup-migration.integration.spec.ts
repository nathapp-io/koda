import { canRunDbTests } from '../../helpers/test-environment';
/**
 * US-009 (finding 5): the additive table a fleet repository delete captures file cleanup targets into, and the
 * constraints the Prisma model promises (required `bundleKeys`, one record per job, due-work order, no parent).
 * The main test schema is built with `prisma db push` and never runs migrations, so the shipped SQL is applied
 * here to a throwaway schema.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-retired-job-cleanup-migration.integration.spec.ts
 */
import { applyMigration, scratchSchemaBefore, ScratchSchema } from '../../helpers/migration-schema';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
const TARGET = '20261219090000_fleet_retired_job_cleanup';

describeIntegration('retired job cleanup migration (US-009)', () => {
  vi.setConfig({ testTimeout: 120_000 });
  let scratch: ScratchSchema;

  /** The table's columns as Postgres has them after the migration. */
  const columns = () => scratch.db.$queryRawUnsafe<Array<{ column_name: string; is_nullable: string; data_type: string }>>(
    `SELECT column_name, is_nullable, data_type FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'FleetRetiredJobCleanup'
     ORDER BY ordinal_position`,
  );
  const indexNames = async () =>
    (await scratch.db.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = current_schema() AND tablename = 'FleetRetiredJobCleanup'
       ORDER BY indexname`,
    )).map((row) => row.indexname);
  const insert = (id: string, jobId: string, bundleKeys: string) => scratch.db.$executeRawUnsafe(
    `INSERT INTO "FleetRetiredJobCleanup" ("id", "jobId", "leaseEpoch", "finishedAt", "bundleKeys")
     VALUES ('${id}', '${jobId}', 1, CURRENT_TIMESTAMP, ${bundleKeys})`,
  );

  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'fleet_retired_job_cleanup_migration', TARGET);
    await applyMigration(scratch.db, TARGET);
  });
  afterAll(async () => {
    await scratch?.drop();
  });

  it('creates the independent table with the columns the model declares', async () => {
    expect((await columns()).map((column) => [column.column_name, column.data_type])).toEqual([
      ['id', 'text'],
      ['jobId', 'text'],
      ['leaseEpoch', 'integer'],
      ['finishedAt', 'timestamp without time zone'],
      ['bundleKeys', 'ARRAY'],
      ['createdAt', 'timestamp without time zone'],
    ]);
  });

  it('declares bundleKeys NOT NULL, as the required Prisma String[] does', async () => {
    expect((await columns()).find((column) => column.column_name === 'bundleKeys')?.is_nullable).toBe('NO');

    await expect(insert('c-null', 'j-null', 'NULL')).rejects.toThrow();
    // An empty array is a real value: a deleted job may have uploaded no bundle at all.
    await expect(insert('c-empty', 'j-empty', "'{}'::TEXT[]")).resolves.toBe(1);
    await expect(insert('c-keys', 'j-keys', `ARRAY['jobs/j-keys/1/b.tar.gz']`)).resolves.toBe(1);
    const stored = await scratch.db.$queryRawUnsafe<Array<{ bundleKeys: string[] }>>(
      `SELECT "bundleKeys" FROM "FleetRetiredJobCleanup" WHERE "id" = 'c-keys'`,
    );
    expect(stored[0].bundleKeys).toEqual(['jobs/j-keys/1/b.tar.gz']);
  });

  it('takes one record per job and carries no foreign key to the deleted parents', async () => {
    await insert('c-first', 'j-unique', "'{}'::TEXT[]");
    await expect(insert('c-second', 'j-unique', "'{}'::TEXT[]")).rejects.toThrow();

    const foreignKeys = await scratch.db.$queryRawUnsafe<Array<{ conname: string }>>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = '"FleetRetiredJobCleanup"'::regclass AND contype = 'f'`,
    );
    expect(foreignKeys).toEqual([]);
  });

  it('indexes the due-work order the retention pass pages by', async () => {
    expect(await indexNames()).toEqual([
      'FleetRetiredJobCleanup_finishedAt_id_idx',
      'FleetRetiredJobCleanup_jobId_key',
      'FleetRetiredJobCleanup_pkey',
    ]);
  });
});

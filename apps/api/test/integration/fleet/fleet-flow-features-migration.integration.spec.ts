import { canRunDbTests } from '../../helpers/test-environment';
/**
 * US-001 AC-1..AC-3 (PG): migration 20261203090000_fleet_flow_features gives every flow job the feature it
 * belongs to, gives every flow feature its own branch column and gives every flow the sha of the approved set.
 *
 * The schema is a throwaway schema inside the test database: `prisma db push` never runs migrations, so this is
 * the only place the committed SQL is executed. The rows are seeded before the migration with raw SQL, naming only
 * the columns the schema has then: the generated client always matches the current schema.
 * Run: cd apps/api && KODA_DB_TESTS=1 bunx vitest run test/integration/fleet/fleet-flow-features-migration.integration.spec.ts
 */
import { applyMigration, migrationsBefore, scratchSchemaBefore, type ScratchSchema } from '../../helpers/migration-schema';

// The nax sandbox withholds host Postgres/Docker.
const describeDb = canRunDbTests() ? describe : describe.skip;
const MIGRATION = '20261203090000_fleet_flow_features';
const SCHEMA = 'fleet_flow_features_mig';
vi.setConfig({ testTimeout: 60_000 });

interface FlowFeatureRow { flowFeatureId: string | null }

describeDb('fleet flow features migration (PG)', () => {
  let scratch: ScratchSchema;

  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, SCHEMA, MIGRATION);

    // A flow with two features, a job that belongs to it and a job that belongs to no flow.
    await scratch.db.$executeRawUnsafe(
      `INSERT INTO "Project" ("id", "name", "slug", "key", "updatedAt") VALUES ('p1', 'p1', 'slug-1', 'K1', now())`,
    );
    await scratch.db.$executeRawUnsafe(
      `INSERT INTO "FleetRepo" ("id", "projectId", "provider", "owner", "name", "defaultBranch", "createdById")
       VALUES ('r1', 'p1', 'github', 'acme', 'app', 'main', 'u1')`,
    );
    await scratch.db.$executeRawUnsafe(
      `INSERT INTO "FleetFlow" ("id", "projectId", "repoId", "entry", "createdByType", "createdById", "branch", "specSha",
                                 "reviewerRole", "supervisorRole", "costCapUsd", "updatedAt")
       VALUES ('f1', 'p1', 'r1', 'NAX', 'USER', 'u1', 'feat/a', 'sha-1', 'opus', 'haiku', 10, now())`,
    );
    await scratch.db.$executeRawUnsafe(
      `INSERT INTO "FleetFlowFeature" ("id", "flowId", "position", "feature", "specPath", "dependsOn")
       VALUES ('ff0', 'f1', 0, 'a', '.nax/features/a/spec.md', ARRAY[]::text[]),
              ('ff1', 'f1', 1, 'b', '.nax/features/b/spec.md', ARRAY[]::text[])`,
    );
    await scratch.db.$executeRawUnsafe(
      `INSERT INTO "FleetJob" ("id", "projectId", "repoId", "ref", "command", "feature", "profiles", "maxCostUsd",
                               "selectorLabels", "requestedById", "flowId", "flowStep", "updatedAt")
       VALUES ('j1', 'p1', 'r1', 'main', 'PLAN', 'a', '{}', 5, '{}', 'u1', 'f1', 'PLAN', now()),
              ('j2', 'p1', 'r1', 'main', 'PLAN', 'x', '{}', 5, '{}', 'u1', NULL, NULL, now())`,
    );

    await applyMigration(scratch.db, MIGRATION);
  }, 120_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  /**
   * The job's flow feature, read with raw SQL: the generated client always selects the columns of the
   * *current* schema, and this scratch schema predates the rule-override column (US-008), so a client
   * read would ask for a column the schema does not have.
   */
  const flowFeatureOf = async (id: string): Promise<FlowFeatureRow> => {
    const rows = await scratch.db.$queryRawUnsafe<FlowFeatureRow[]>(
      `SELECT "flowFeatureId"::text AS "flowFeatureId" FROM "FleetJob" WHERE "id" = '${id}'`,
    );
    expect(rows).toHaveLength(1);
    return rows[0];
  };

  it('AC-1: a job of a flow is scoped to the position-0 feature of that flow', async () => {
    // The chain must really have run, or the backfill would run against an empty schema.
    expect(migrationsBefore(MIGRATION).length).toBeGreaterThan(0);
    const job = await flowFeatureOf('j1');
    expect(job.flowFeatureId).toBe('ff0');
  });

  it('AC-2: a job that belongs to no flow has no flow feature', async () => {
    const job = await flowFeatureOf('j2');
    expect(job.flowFeatureId).toBeNull();
  });

  it('AC-3: every feature starts without a branch and every flow carries its spec sha as its set sha', async () => {
    const features = await scratch.db.fleetFlowFeature.findMany({ where: { flowId: 'f1' }, orderBy: { position: 'asc' } });
    expect(features.map((feature) => feature.branch)).toEqual([null, null]);
    const flow = await scratch.db.fleetFlow.findUniqueOrThrow({ where: { id: 'f1' } });
    expect(flow.setSha).toBe(flow.specSha);
  });
});

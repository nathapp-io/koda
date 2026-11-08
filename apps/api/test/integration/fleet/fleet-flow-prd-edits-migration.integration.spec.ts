import { randomUUID } from 'node:crypto';
import { canRunDbTests } from '../../helpers/test-environment';
import { applyMigration, scratchSchemaBefore, type ScratchSchema } from '../../helpers/migration-schema';

const MIGRATION = '20261202090000_fleet_flow_prd_edits';
const describeDb = canRunDbTests() ? describe : describe.skip;

describeDb('fleet flow PRD edits migration (PG)', () => {
  let scratch: ScratchSchema;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('Test database URL missing');
    scratch = await scratchSchemaBefore(url, `flow_prd_edits_${randomUUID().replaceAll('-', '')}`, MIGRATION);
  }, 120_000);

  afterAll(async () => { await scratch?.drop(); });

  it('AC-1 adds a nullable PRD edits job marker and defaults existing feature rows to null', async () => {
    const id = randomUUID();
    const projectId = `project-${id}`;
    const repoId = `repo-${id}`;
    const flowId = `flow-${id}`;
    const featureId = `feature-${id}`;
    await scratch.db.$executeRaw`INSERT INTO "Project" ("id", "name", "slug", "key", "updatedAt") VALUES (${projectId}, ${projectId}, ${`slug-${id}`}, ${`key-${id}`}, now())`;
    await scratch.db.$executeRaw`INSERT INTO "FleetRepo" ("id", "projectId", "provider", "owner", "name", "defaultBranch", "createdById") VALUES (${repoId}, ${projectId}, 'github', 'owner', ${`repo-${id}`}, 'main', 'creator')`;
    await scratch.db.$executeRaw`INSERT INTO "FleetFlow" ("id", "projectId", "repoId", "entry", "createdByType", "createdById", "branch", "specSha", "reviewerRole", "supervisorRole", "costCapUsd", "updatedAt") VALUES (${flowId}, ${projectId}, ${repoId}, 'NAX', 'USER', 'creator', 'main', 'sha', 'reviewer', 'supervisor', 10, now())`;
    await scratch.db.$executeRaw`INSERT INTO "FleetFlowFeature" ("id", "flowId", "position", "feature", "specPath", "dependsOn") VALUES (${featureId}, ${flowId}, 0, 'feature', 'spec.md', ARRAY[]::text[])`;

    const beforeColumns = await scratch.db.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'FleetFlowFeature' AND column_name = 'prdEditsJobId'`;
    expect(beforeColumns).toEqual([]);

    await applyMigration(scratch.db, MIGRATION);

    const columns = await scratch.db.$queryRaw<Array<{ column_name: string; is_nullable: string; data_type: string }>>`
      SELECT column_name, is_nullable, data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'FleetFlowFeature' AND column_name = 'prdEditsJobId'`;
    expect(columns).toEqual([{ column_name: 'prdEditsJobId', is_nullable: 'YES', data_type: 'text' }]);
    expect((await scratch.db.fleetFlowFeature.findUniqueOrThrow({ where: { id: featureId } })).prdEditsJobId).toBeNull();
  });
});

import { randomUUID } from 'node:crypto';
import { canRunDbTests } from '../../helpers/test-environment';
import { applyMigration, scratchSchemaBefore, type ScratchSchema } from '../../helpers/migration-schema';

const MIGRATION = '20261130090000_fleet_flow_answers';
const describeDb = canRunDbTests() ? describe : describe.skip;

describeDb('fleet flow answers migration (PG)', () => {
  let scratch: ScratchSchema;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('Test database URL missing');
    scratch = await scratchSchemaBefore(url, `flow_answers_${randomUUID().replaceAll('-', '')}`, MIGRATION);
  }, 120_000);

  afterAll(async () => { await scratch?.drop(); });

  it('adds the five nullable answer columns and keeps the rows that were there', async () => {
    const id = randomUUID();
    const projectId = `project-${id}`;
    const repoId = `repo-${id}`;
    const flowId = `flow-${id}`;
    const featureId = `feature-${id}`;
    // The row is written with the columns the schema had before the migration.
    await scratch.db.$executeRaw`INSERT INTO "Project" ("id", "name", "slug", "key", "updatedAt") VALUES (${projectId}, ${projectId}, ${`slug-${id}`}, ${`key-${id}`}, now())`;
    await scratch.db.$executeRaw`INSERT INTO "FleetRepo" ("id", "projectId", "provider", "owner", "name", "defaultBranch", "createdById") VALUES (${repoId}, ${projectId}, 'github', 'owner', ${`repo-${id}`}, 'main', 'creator')`;
    await scratch.db.$executeRaw`INSERT INTO "FleetFlow" ("id", "projectId", "repoId", "entry", "createdByType", "createdById", "branch", "specSha", "reviewerRole", "supervisorRole", "costCapUsd", "updatedAt") VALUES (${flowId}, ${projectId}, ${repoId}, 'NAX', 'USER', 'creator', 'main', 'sha', 'reviewer', 'supervisor', 10, now())`;
    await scratch.db.$executeRaw`INSERT INTO "FleetFlowFeature" ("id", "flowId", "position", "feature", "specPath", "dependsOn") VALUES (${featureId}, ${flowId}, 0, 'feature', 'spec.md', ARRAY[]::text[])`;

    await applyMigration(scratch.db, MIGRATION);
    // The generated client selects every FleetFlowFeature scalar, including `rulingsJobId`, which only
    // the later fleet_flow_rulings migration adds. Apply it so the read below can use the client; the
    // assertions still cover only what the answers migration writes.
    await applyMigration(scratch.db, '20261201090000_fleet_flow_rulings');
    // The generated client selects the later PRD-edits scalar too, so apply its migration before reading.
    await applyMigration(scratch.db, '20261202090000_fleet_flow_prd_edits');
    // The generated client selects the later feature scalars (`branch`) too, so apply their migration.
    await applyMigration(scratch.db, '20261203090000_fleet_flow_features');

    const columns = await scratch.db.$queryRaw<Array<{ column_name: string; is_nullable: string; data_type: string }>>`
      SELECT column_name, is_nullable, data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'FleetFlowFeature'
        AND column_name IN ('questionsJobId', 'questions', 'answers', 'answeredById', 'answeredAt')`;
    expect(columns).toEqual(expect.arrayContaining([
      { column_name: 'questionsJobId', is_nullable: 'YES', data_type: 'text' },
      { column_name: 'questions', is_nullable: 'YES', data_type: 'jsonb' },
      { column_name: 'answers', is_nullable: 'YES', data_type: 'jsonb' },
      { column_name: 'answeredById', is_nullable: 'YES', data_type: 'text' },
      { column_name: 'answeredAt', is_nullable: 'YES', data_type: 'timestamp without time zone' },
    ]));

    const feature = await scratch.db.fleetFlowFeature.findUniqueOrThrow({ where: { id: featureId } });
    expect(feature).toMatchObject({
      questionsJobId: null, questions: null, answers: null, answeredById: null, answeredAt: null,
    });
  });
});

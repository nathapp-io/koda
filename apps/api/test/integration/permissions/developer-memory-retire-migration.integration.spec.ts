import { canRunDbTests } from '../../helpers/test-environment';
import { migrationStatements, scratchSchemaBefore, type ScratchSchema } from '../../helpers/migration-schema';

const integration = canRunDbTests() ? describe : describe.skip;
const MIGRATION = '20261116090000_developer_memory_decision_retire';
const BEFORE = ['*.read', 'memory.decision.record', 'memory.update.own'];
const AFTER = ['*.read', 'memory.decision.record', 'memory.decision.retire', 'memory.update.own'];

integration('developer memory decision retire permission migration', () => {
  let scratch: ScratchSchema;
  let updateRoleStatement: string;

  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'developer_memory_retire_mig', MIGRATION);
    updateRoleStatement = migrationStatements(MIGRATION).find((statement) => statement.includes('UPDATE "Role" role')) ?? '';
    if (!updateRoleStatement) throw new Error('Developer role update is missing from migration');
    await scratch.db.$executeRawUnsafe(
      `INSERT INTO "Role" ("id", "key", "name", "scope", "permissions", "updatedAt") VALUES
       ('developer', 'developer', 'Developer', 'PROJECT', $1::jsonb, now()),
       ('viewer', 'viewer', 'Viewer', 'PROJECT', $2::jsonb, now())`,
      JSON.stringify(BEFORE), JSON.stringify(['project.read']),
    );
  }, 120_000);
  beforeEach(async () => {
    await scratch.db.$executeRawUnsafe('UPDATE "Role" SET "permissions" = $1::jsonb WHERE "key" = \'developer\'', JSON.stringify(BEFORE));
    await scratch.db.$executeRawUnsafe('UPDATE "Role" SET "permissions" = $1::jsonb WHERE "key" = \'viewer\'', JSON.stringify(['project.read']));
  });
  afterAll(async () => { await scratch?.drop(); });

  it('AC-1: inserts retirement permission immediately after decision.record', async () => {
    await scratch.db.$executeRawUnsafe(updateRoleStatement);
    const rows = await scratch.db.$queryRawUnsafe<Array<{ permissions: string[] }>>('SELECT "permissions" FROM "Role" WHERE "key" = \'developer\'');
    expect(rows[0]?.permissions).toEqual(AFTER);
  });

  it('AC-2: leaves developer permissions unchanged on a second application', async () => {
    await scratch.db.$executeRawUnsafe(updateRoleStatement);
    const before = await scratch.db.$queryRawUnsafe<Array<{ permissions: string[] }>>('SELECT "permissions" FROM "Role" WHERE "key" = \'developer\'');
    await scratch.db.$executeRawUnsafe(updateRoleStatement);
    const after = await scratch.db.$queryRawUnsafe<Array<{ permissions: string[] }>>('SELECT "permissions" FROM "Role" WHERE "key" = \'developer\'');
    expect(after).toEqual(before);
  });

  it('AC-3: does not alter viewer permissions', async () => {
    await scratch.db.$executeRawUnsafe(updateRoleStatement);
    const rows = await scratch.db.$queryRawUnsafe<Array<{ permissions: string[] }>>('SELECT "permissions" FROM "Role" WHERE "key" = \'viewer\'');
    expect(rows[0]?.permissions).toEqual(['project.read']);
  });
});

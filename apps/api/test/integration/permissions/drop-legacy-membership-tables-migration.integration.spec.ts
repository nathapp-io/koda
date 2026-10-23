import { applyMigration, scratchSchemaBefore, type ScratchSchema } from '../../helpers/migration-schema';

const integration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const MIGRATION = '20261102090100_drop_legacy_membership_tables';

integration('legacy membership table drop migration', () => {
  let scratch: ScratchSchema;
  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'membership_tables_drop_mig', MIGRATION);
    const db = scratch.db;
    await db.$executeRawUnsafe(`INSERT INTO "User" ("id", "email", "passwordHash", "updatedAt") VALUES ('u1', 'legacy@test.dev', 'x', now())`);
    await db.$executeRawUnsafe(`INSERT INTO "Agent" ("id", "name", "slug", "apiKeyHash", "updatedAt") VALUES ('a1', 'Agent', 'legacy-agent', 'hash', now())`);
    await db.$executeRawUnsafe(`INSERT INTO "Project" ("id", "name", "slug", "key", "updatedAt") VALUES ('p1', 'P', 'p', 'PP', now())`);
    await db.$executeRawUnsafe(`INSERT INTO "Role" ("id", "key", "name", "scope", "permissions", "updatedAt") VALUES ('r1', 'custom', 'Custom', 'PROJECT', '[]', now())`);
    await db.$executeRawUnsafe(`INSERT INTO "RoleBinding" ("id", "principalType", "principalId", "roleId", "projectId", "grantedByType", "grantedById") VALUES ('b1', 'USER', 'u1', 'r1', 'p1', 'SYSTEM', 'test')`);
    await db.$executeRawUnsafe(`INSERT INTO "ProjectMember" ("id", "projectId", "userId", "role") VALUES ('m1', 'p1', 'u1', 'DEVELOPER')`);
    await db.$executeRawUnsafe(`INSERT INTO "AgentProject" ("agentId", "projectId", "addedById") VALUES ('a1', 'p1', 'u1')`);
    await db.$executeRawUnsafe(`INSERT INTO "AgentRoleEntry" ("id", "agentId", "role") VALUES ('ar1', 'a1', 'DEVELOPER')`);
    await applyMigration(db, MIGRATION);
  }, 120_000);
  afterAll(async () => { await scratch?.drop(); });

  it.each(['ProjectMember', 'AgentProject', 'AgentRoleEntry'])('AC-1/2/3: drops %s', async table => {
    expect(await scratch.db.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1`, table,
    )).toEqual([]);
  });
  it('AC-4: preserves the binding unchanged', async () => {
    expect(await scratch.db.$queryRawUnsafe('SELECT "principalId", "roleId", "projectId" FROM "RoleBinding" WHERE "id" = \'b1\'')).toEqual([
      { principalId: 'u1', roleId: 'r1', projectId: 'p1' },
    ]);
  });
  it('AC-5: preserves the referenced user, agent and project', async () => {
    for (const [table, id] of [['User', 'u1'], ['Agent', 'a1'], ['Project', 'p1']]) {
      expect(await scratch.db.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE "id" = $1`, id)).toEqual([{ id }]);
    }
  });
});

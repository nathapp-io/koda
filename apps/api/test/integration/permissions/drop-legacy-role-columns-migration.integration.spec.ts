import { canRunDbTests } from '../../helpers/test-environment';
import { applyMigration, scratchSchemaBefore, type ScratchSchema } from '../../helpers/migration-schema';

// The nax sandbox withholds host Postgres/Docker.
const integration = canRunDbTests() ? describe : describe.skip;
const MIGRATION = '20261102090000_drop_legacy_role_columns';

integration('legacy role column drop migration', () => {
  let scratch: ScratchSchema;
  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'role_columns_drop_mig', MIGRATION);
    const db = scratch.db;
    await db.$executeRawUnsafe(`INSERT INTO "User" ("id", "email", "passwordHash", "role", "tokenVersion", "disabled", "updatedAt") VALUES ('u1', 'legacy@test.dev', 'x', 'ADMIN', 7, true, now())`);
    await db.$executeRawUnsafe(`INSERT INTO "Project" ("id", "name", "slug", "key", "updatedAt") VALUES ('p1', 'P', 'p', 'PP', now())`);
    await db.$executeRawUnsafe(`INSERT INTO "Role" ("id", "key", "name", "scope", "permissions", "updatedAt") VALUES ('r1', 'custom', 'Custom', 'PROJECT', '[]', now())`);
    await db.$executeRawUnsafe(`INSERT INTO "ProjectInvite" ("id", "projectId", "email", "role", "roleId", "status", "tokenHash", "expiresAt", "updatedAt") VALUES ('i1', 'p1', 'invite@test.dev', 'VIEWER', 'r1', 'PENDING', 'preserved-hash', now(), now())`);
    await applyMigration(db, MIGRATION);
  }, 120_000);
  afterAll(async () => { await scratch?.drop(); });

  it.each(['User', 'ProjectInvite'])('drops %s.role (AC-1/2)', async table => {
    const columns = await scratch.db.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'role'`, table,
    );
    expect(columns).toEqual([]);
  });
  it('AC-3: preserves the user account and revocation state', async () => {
    expect(await scratch.db.$queryRawUnsafe('SELECT "id", "email", "tokenVersion", "disabled" FROM "User"')).toEqual([
      { id: 'u1', email: 'legacy@test.dev', tokenVersion: 7, disabled: true },
    ]);
  });
  it('AC-4: preserves the invite role reference and lifecycle', async () => {
    expect(await scratch.db.$queryRawUnsafe('SELECT "roleId", "status", "tokenHash" FROM "ProjectInvite"')).toEqual([
      { roleId: 'r1', status: 'PENDING', tokenHash: 'preserved-hash' },
    ]);
  });
});

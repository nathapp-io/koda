/**
 * Permissions P1a US-002 — the role/binding migration itself.
 *
 * `test/global-setup.ts` builds the test schema with `prisma db push` and never runs migrations, so
 * nothing else executes `20261027090000_role_bindings`. This spec applies every earlier migration to a
 * scratch schema, then this one, and inspects what it created: production migrates; tests push.
 */
import { applyMigration, scratchSchemaBefore, type ScratchSchema } from '../../helpers/migration-schema';

const integration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const MIGRATION = '20261027090000_role_bindings';

integration('role bindings migration (PG)', () => {
  let scratch: ScratchSchema;
  let projectId: string;

  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'role_bindings_mig', MIGRATION);
    await applyMigration(scratch.db, MIGRATION);
    const project = await scratch.db.project.create({ data: { name: 'P', slug: 'p', key: 'P' } });
    projectId = project.id;
  }, 300_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  it('creates both tables with the documented columns', async () => {
    const columns = async (table: string): Promise<string[]> => {
      const rows = await scratch.db.$queryRawUnsafe<Array<{ column_name: string }>>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY column_name`,
        table,
      );
      return rows.map((row) => row.column_name);
    };

    expect(await columns('Role')).toEqual([
      'createdAt',
      'description',
      'id',
      'key',
      'locked',
      'name',
      'permissions',
      'scope',
      'system',
      'updatedAt',
    ]);
    expect(await columns('RoleBinding')).toEqual([
      'createdAt',
      'grantedById',
      'grantedByType',
      'id',
      'principalId',
      'principalType',
      'projectId',
      'roleId',
    ]);
  });

  it('makes Role.key unique and links a binding to its role and project', async () => {
    const indexes = await scratch.db.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename IN ('Role', 'RoleBinding') ORDER BY indexname`,
    );
    expect(indexes.map((row) => row.indexname)).toEqual([
      'RoleBinding_pkey',
      'RoleBinding_principalId_roleId_global_key',
      'RoleBinding_principalId_roleId_projectId_key',
      'RoleBinding_principalType_principalId_idx',
      'RoleBinding_projectId_idx',
      'RoleBinding_roleId_idx',
      'Role_key_key',
      'Role_pkey',
    ]);

    const rules = await scratch.db.$queryRawUnsafe<Array<{ constraint_name: string; delete_rule: string }>>(
      `SELECT rc.constraint_name, rc.delete_rule
       FROM information_schema.referential_constraints rc
       JOIN information_schema.table_constraints tc
         ON tc.constraint_name = rc.constraint_name AND tc.constraint_schema = rc.constraint_schema
       WHERE rc.constraint_schema = current_schema() AND tc.table_name = 'RoleBinding'
       ORDER BY rc.constraint_name`,
    );
    expect(rules).toEqual([
      { constraint_name: 'RoleBinding_projectId_fkey', delete_rule: 'CASCADE' },
      { constraint_name: 'RoleBinding_roleId_fkey', delete_rule: 'RESTRICT' },
    ]);
  });

  it('rejects a duplicate global binding from the shipped partial index', async () => {
    const role = await scratch.db.role.create({
      data: { key: 'developer', name: 'Developer', scope: 'PROJECT', system: true, locked: false, permissions: ['ticket.read'] },
    });
    const binding = {
      principalType: 'USER',
      principalId: 'user-1',
      roleId: role.id,
      projectId: null,
      grantedByType: 'SYSTEM',
      grantedById: 'seed',
    };

    await scratch.db.roleBinding.create({ data: binding });

    // A plain unique index over a nullable column admits any number of NULL rows; only the partial
    // index `WHERE "projectId" IS NULL` rejects this one.
    await expect(scratch.db.roleBinding.create({ data: binding })).rejects.toMatchObject({ code: 'P2002' });
    await expect(scratch.db.roleBinding.count()).resolves.toBe(1);
  });

  it('rejects a duplicate project binding from the shipped partial index', async () => {
    const role = await scratch.db.role.create({
      data: { key: 'reviewer', name: 'Reviewer', scope: 'PROJECT', system: true, locked: false, permissions: ['ticket.read'] },
    });
    const binding = {
      principalType: 'AGENT',
      principalId: 'agent-1',
      roleId: role.id,
      projectId,
      grantedByType: 'SYSTEM',
      grantedById: 'seed',
    };

    await scratch.db.roleBinding.create({ data: binding });

    await expect(scratch.db.roleBinding.create({ data: binding })).rejects.toMatchObject({ code: 'P2002' });
  });
});

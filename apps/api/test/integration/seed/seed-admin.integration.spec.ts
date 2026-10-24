import { canRunDbTests } from '../../helpers/test-environment';
import * as bcrypt from 'bcrypt';
import { seedAdminUser } from '../../../prisma/seed-admin-data';
import { ensureSystemRoles, grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { createTestPrismaClient } from '../../helpers/test-prisma';
import { resetDb } from '../../helpers/reset-db';

// The nax sandbox withholds host Postgres/Docker.
const dbDescribe = canRunDbTests() ? describe : describe.skip;

dbDescribe('production admin seed bindings', () => {
  const db = createTestPrismaClient();
  const input = { email: 'seed@koda.test', name: 'Seed Admin', password: 'Seed1234!Aa' };
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await db.$disconnect(); });

  const bindings = async (id: string) => (await db.roleBinding.findMany({
    where: { principalType: 'USER', principalId: id }, include: { role: true }, take: 10,
  })).map(({ role, projectId }) => ({ key: role.key, projectId })).sort((a, b) => a.key.localeCompare(b.key));

  it('AC-10/11: first admin becomes owner with exactly member and owner global bindings', async () => {
    const result = await seedAdminUser(db, input);
    const user = await db.user.findUniqueOrThrow({ where: { email: input.email } });
    expect(result).toEqual({ created: true, userId: user.id, roleKey: 'owner' });
    expect(await bindings(user.id)).toEqual([{ key: 'member', projectId: null }, { key: 'owner', projectId: null }]);
    expect(await bcrypt.compare(input.password, user.passwordHash)).toBe(true);
    expect(bcrypt.getRounds(user.passwordHash)).toBe(12);
  });

  it('AC-12/13: an existing owner makes the next admin an admin, not a second owner', async () => {
    const owner = await db.user.create({ data: { email: 'owner@koda.test', name: 'Owner', passwordHash: 'hash' } });
    await grantBaseline(db, { type: 'USER', id: owner.id });
    await grantRole(db, { type: 'USER', id: owner.id }, 'owner');
    const result = await seedAdminUser(db, input);
    const user = await db.user.findUniqueOrThrow({ where: { email: input.email } });
    expect(result).toEqual({ created: true, userId: user.id, roleKey: 'admin' });
    expect(await bindings(user.id)).toEqual([{ key: 'admin', projectId: null }, { key: 'member', projectId: null }]);
  });

  it('F1: concurrent new emails create exactly one owner and one admin', async () => {
    await ensureSystemRoles(db);
    const results = await Promise.all([
      seedAdminUser(db, input),
      seedAdminUser(db, { ...input, email: 'second@koda.test' }),
    ]);
    expect(results.every(result => result.created)).toBe(true);
    expect(results.flatMap(result => result.created ? [result.roleKey] : []).sort()).toEqual(['admin', 'owner']);
    for (const result of results) {
      if (!result.created) throw new Error('expected new user');
      expect(await bindings(result.userId)).toEqual(
        [{ key: 'member', projectId: null }, { key: result.roleKey, projectId: null }]
          .sort((a, b) => a.key.localeCompare(b.key)),
      );
    }
  });

  it('F1: concurrent identical emails yield one creation and one no-op', async () => {
    await ensureSystemRoles(db);
    const results = await Promise.all([seedAdminUser(db, input), seedAdminUser(db, input)]);
    expect(results.filter(result => result.created)).toHaveLength(1);
    expect(results).toContainEqual({ created: false });
    expect(await db.user.count()).toBe(1);
    expect(await db.roleBinding.count()).toBe(2);
  });

  it('F1: a failed owner grant rolls back the user, baseline and system-role seed', async () => {
    await db.$executeRawUnsafe(`CREATE FUNCTION seed_admin_reject_owner() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM "Role" WHERE id = NEW."roleId" AND key = 'owner') THEN
          RAISE EXCEPTION 'seed grant failure';
        END IF;
        RETURN NEW;
      END $$`);
    try {
      await db.$executeRawUnsafe(`CREATE TRIGGER seed_admin_reject_owner BEFORE INSERT ON "RoleBinding"
        FOR EACH ROW EXECUTE FUNCTION seed_admin_reject_owner()`);
      await expect(seedAdminUser(db, input)).rejects.toThrow('seed grant failure');
      expect(await db.user.count()).toBe(0);
      expect(await db.roleBinding.count()).toBe(0);
      expect(await db.role.count()).toBe(0);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS seed_admin_reject_owner ON "RoleBinding"');
      await db.$executeRawUnsafe('DROP FUNCTION seed_admin_reject_owner()');
    }
  });

  it('AC-14/15: existing email returns false and writes nothing, even with system roles absent', async () => {
    const user = await db.user.create({ data: { email: input.email, name: 'Unchanged', passwordHash: 'unchanged' } });
    const counts = await Promise.all([db.user.count(), db.roleBinding.count(), db.role.count()]);
    expect(await seedAdminUser(db, input)).toEqual({ created: false });
    expect(await Promise.all([db.user.count(), db.roleBinding.count(), db.role.count()])).toEqual(counts);
    expect(await db.user.findUniqueOrThrow({ where: { id: user.id } })).toEqual(user);
  });
});

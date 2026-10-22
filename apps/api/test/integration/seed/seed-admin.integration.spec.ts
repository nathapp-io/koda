import * as bcrypt from 'bcrypt';
import { seedAdminUser } from '../../../prisma/seed-admin-data';
import { grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { createTestPrismaClient } from '../../helpers/test-prisma';
import { resetDb } from '../../helpers/reset-db';

const dbDescribe = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

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
    expect(user.role).toBe('ADMIN');
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
    expect(user.role).toBe('ADMIN');
  });

  it('AC-14/15: existing email returns false and writes nothing, even with system roles absent', async () => {
    const user = await db.user.create({ data: { email: input.email, name: 'Unchanged', passwordHash: 'unchanged' } });
    const counts = await Promise.all([db.user.count(), db.roleBinding.count(), db.role.count()]);
    expect(await seedAdminUser(db, input)).toEqual({ created: false });
    expect(await Promise.all([db.user.count(), db.roleBinding.count(), db.role.count()])).toEqual(counts);
    expect(await db.user.findUniqueOrThrow({ where: { id: user.id } })).toEqual(user);
  });
});

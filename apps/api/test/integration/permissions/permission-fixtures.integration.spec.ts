import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { AppModule } from '../../../src/app.module';
import type { KodaPrincipal } from '../../../src/auth/principal/koda-principal.types';
import { PermissionService } from '../../../src/permissions/permission.service';
import { SYSTEM_ROLES } from '../../../src/permissions/system-roles';
import {
  ensureSystemRoles,
  expectBindingOnlyFixtures,
  fixtureGrantReport,
  grantBaseline,
  grantRole,
  revokeProjectRoles,
} from '../../../src/permissions/test-helpers/permission-fixtures';
import type { PrincipalRef } from '../../../src/permissions/permissions.types';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('permission fixture bindings (PG)', () => {
  let moduleRef: TestingModule;
  let db: PrismaClient;
  let permissions: PermissionService;
  let counter = 0;

  const user = async (role = 'MEMBER') => {
    counter += 1;
    return db.user.create({ data: { email: `fixture-${counter}@koda.test`, name: 'Fixture', passwordHash: 'x', role } });
  };
  const project = async () => {
    counter += 1;
    return db.project.create({ data: { name: `Fixture ${counter}`, slug: `fixture-${counter}`, key: `F${counter}` } });
  };
  const agent = async () => {
    counter += 1;
    return db.agent.create({ data: { name: 'Fixture', slug: `fixture-agent-${counter}`, apiKeyHash: `hash-${counter}` } });
  };
  const ref = (id: string): PrincipalRef => ({ type: 'USER', id });

  beforeAll(async () => {
    await resetDb();
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    db = moduleRef.get(PrismaService<PrismaClient>, { strict: false }).client as PrismaClient;
    permissions = moduleRef.get(PermissionService);
  });
  afterAll(async () => { await moduleRef?.close(); });
  beforeEach(async () => {
    await db.roleBinding.deleteMany();
    await db.agentRoleEntry.deleteMany();
    await db.projectMember.deleteMany();
    await db.agentProject.deleteMany();
    await db.agent.deleteMany();
    await db.user.deleteMany();
    await db.project.deleteMany();
  });

  it('AC-1/2: seeds exactly the system roles with seeded values idempotently', async () => {
    await ensureSystemRoles(db);
    const roles = await db.role.findMany({ orderBy: { key: 'asc' } });
    expect(roles).toHaveLength(11);
    expect(roles.map(({ key }) => key).sort()).toEqual(SYSTEM_ROLES.map(({ key }) => key).sort());
    for (const seed of SYSTEM_ROLES) {
      expect(roles.find((role) => role.key === seed.key)).toMatchObject({
        scope: seed.scope, permissions: [...seed.permissions], locked: seed.locked ?? false, system: seed.system ?? true,
      });
    }
    await ensureSystemRoles(db);
    expect(await db.role.count()).toBe(11);
  });
  it('AC-3: restores edited locked-role permissions', async () => {
    await ensureSystemRoles(db);
    const owner = await db.role.findUniqueOrThrow({ where: { key: 'owner' } });
    await db.role.update({ where: { id: owner.id }, data: { permissions: ['ticket.read'] } });
    await ensureSystemRoles(db);
    expect((await db.role.findUniqueOrThrow({ where: { key: 'owner' } })).permissions).toEqual(['*']);
  });
  it('AC-4/5: creates and idempotently returns a binding with fixture attribution', async () => {
    const u = await user(); const p = await project();
    const first = await grantRole(db, ref(u.id), 'developer', p.id);
    const second = await grantRole(db, ref(u.id), 'developer', p.id);
    expect(second.id).toBe(first.id);
    expect(await db.roleBinding.count({ where: { principalId: u.id, projectId: p.id } })).toBe(1);
    expect(await db.roleBinding.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({
      roleId: (await db.role.findUniqueOrThrow({ where: { key: 'developer' } })).id,
      principalType: 'USER', projectId: p.id, grantedByType: 'SYSTEM', grantedById: 'test',
    });
  });
  it('AC-6: unknown role rejects without creating a binding', async () => {
    const u = await user(); const p = await project();
    await expect(grantRole(db, ref(u.id), 'no-such-role', p.id)).rejects.toThrow('no role no-such-role');
    expect(await db.roleBinding.count({ where: { principalId: u.id } })).toBe(0);
  });
  it('AC-7: mirrors only global admin-role grants to User.role', async () => {
    const admin = await user(); const developer = await user(); const p = await project();
    await grantRole(db, ref(admin.id), 'admin');
    await grantRole(db, ref(developer.id), 'developer', p.id);
    expect((await db.user.findUniqueOrThrow({ where: { id: admin.id } })).role).toBe('ADMIN');
    expect((await db.user.findUniqueOrThrow({ where: { id: developer.id } })).role).toBe('MEMBER');
  });
  it('AC-8: grants user and agent baselines idempotently', async () => {
    const u = await user(); const a = await agent();
    const first = await grantBaseline(db, ref(u.id));
    expect((await db.roleBinding.findUniqueOrThrow({ where: { id: first.id } })).roleId).toBe((await db.role.findUniqueOrThrow({ where: { key: 'member' } })).id);
    const again = await grantBaseline(db, ref(u.id));
    const agentBaseline = await grantBaseline(db, { type: 'AGENT', id: a.id });
    expect(again.id).toBe(first.id);
    expect((await db.roleBinding.findUniqueOrThrow({ where: { id: agentBaseline.id } })).roleId).toBe((await db.role.findUniqueOrThrow({ where: { key: 'agent' } })).id);
  });
  it('AC-9/15: revokes only project bindings and returns zero when absent', async () => {
    const u = await user(); const p = await project(); const q = await project();
    await grantRole(db, ref(u.id), 'developer', p.id);
    await grantRole(db, ref(u.id), 'viewer', p.id);
    await grantRole(db, ref(u.id), 'viewer', q.id);
    await grantBaseline(db, ref(u.id));
    expect(await revokeProjectRoles(db, ref(u.id), p.id)).toBe(2);
    expect(await db.roleBinding.count({ where: { principalId: u.id } })).toBe(2);
    expect(await revokeProjectRoles(db, ref(u.id), p.id)).toBe(0);
  });
  it('AC-10/11/16: reports legacy state and treats missing principals as empty', async () => {
    const u = await user('ADMIN'); const p = await project();
    await db.projectMember.create({ data: { userId: u.id, projectId: p.id, role: 'VIEWER' } });
    expect(await fixtureGrantReport(db, ref(u.id))).toMatchObject({ legacyMemberships: 2, agentRoleEntries: 0, hasGlobalBinding: false, globalProjectRoleBindings: 0 });
    await grantRole(db, ref(u.id), 'admin');
    await db.projectMember.deleteMany({ where: { userId: u.id } });
    expect((await fixtureGrantReport(db, ref(u.id))).legacyMemberships).toBe(0);
    const a = await agent();
    await db.agentProject.create({ data: { agentId: a.id, projectId: p.id } });
    await db.agentRoleEntry.create({ data: { agentId: a.id, role: 'DEVELOPER' } });
    await grantRole(db, { type: 'AGENT', id: a.id }, 'developer');
    expect(await fixtureGrantReport(db, { type: 'AGENT', id: a.id })).toEqual({ legacyMemberships: 1, agentRoleEntries: 1, hasGlobalBinding: true, globalProjectRoleBindings: 1 });
    expect(await fixtureGrantReport(db, { type: 'USER', id: 'missing' })).toEqual({ legacyMemberships: 0, agentRoleEntries: 0, hasGlobalBinding: false, globalProjectRoleBindings: 0 });
  });
  it('AC-12/13/17: sentinel aggregates failures and supports exemptions', async () => {
    const u = await user(); const a = await agent();
    await db.agentRoleEntry.create({ data: { agentId: a.id, role: 'DEVELOPER' } });
    await expect(expectBindingOnlyFixtures(db, [ref(u.id), { type: 'AGENT', id: a.id }])).rejects.toThrow(
      new RegExp(`${u.id}.*hasGlobalBinding.*${a.id}.*agentRoleEntries`),
    );
    await grantBaseline(db, ref(u.id));
    await grantBaseline(db, { type: 'AGENT', id: a.id });
    await expect(expectBindingOnlyFixtures(db, [ref(u.id), { type: 'AGENT', id: a.id }], { agentRoleEntries: [{ type: 'AGENT', id: a.id }] })).resolves.toBeUndefined();
    await db.roleBinding.deleteMany({ where: { principalId: u.id } });
    await expect(expectBindingOnlyFixtures(db, [ref(u.id)])).rejects.toThrow(new RegExp(`${u.id}.*hasGlobalBinding`));
    await expect(expectBindingOnlyFixtures(db, [ref(u.id)], { noBaseline: [ref(u.id)] })).resolves.toBeUndefined();
  });
  it('AC-14: permission service evaluates fixture bindings for the matching authenticated principal', async () => {
    const u = await user(); const p = await project(); const q = await project();
    const principal = { actorType: 'user', id: u.id, role: 'MEMBER', email: u.email } as KodaPrincipal;
    await grantBaseline(db, ref(u.id));
    await grantRole(db, ref(u.id), 'developer', p.id);
    await expect(permissions.can(principal, 'ticket.create', { projectId: p.id })).resolves.toMatchObject({ allowed: true });
    await expect(permissions.can(principal, 'ticket.create', { projectId: q.id })).resolves.toMatchObject({ allowed: false });
  });
});

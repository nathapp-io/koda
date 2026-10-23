import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { EmailAvailability } from '../../../src/email/email-availability';
import { MEMBERSHIP_READ_CAP } from '../../../src/permissions/membership.queries';
import { PrismaProjectMembersRepository } from '../../../src/projects/members/prisma-project-members.repository';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
describeIntegration('project member binding writes (PG HTTP)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let rootToken: string;
  let adminToken: string;
  let targetToken: string;
  let rootId: string;
  let adminId: string;
  let targetId: string;
  let projectId: string;
  let base: string;
  let passwordHash: string;
  let seq = 0;
  const headers = (token = adminToken) => ({ Authorization: `Bearer ${token}` });
  const post = (body: object, token = adminToken) => request(server).post(base).set(headers(token)).send(body);
  const bindings = (id = targetId) => db.roleBinding.findMany({ where: { projectId, principalType: 'USER', principalId: id }, include: { role: true } });
  const bind = async (key: string, id = targetId) => db.roleBinding.create({ data: {
    principalType: 'USER', principalId: id, projectId,
    roleId: (await db.role.findUniqueOrThrow({ where: { key } })).id,
    grantedByType: 'SYSTEM', grantedById: 'test',
  } });
  const legacyCount = () => db.projectMember.count({ where: { projectId, userId: targetId } });
  const conflict = (res: request.Response, prefix: string) => {
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ret: 409, message: prefix === 'members.lastAdmin' ? 'A project must keep at least one admin' : 'User is already a member of this project' });
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    db = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    rootToken = data<{ accessToken: string }>(await request(server).post('/api/auth/register').send({ email: 'root@bindings.test', name: 'Root', password: TEST_PASSWORD }).expect(201)).accessToken;
    const root = await db.user.findUniqueOrThrow({ where: { email: 'root@bindings.test' } });
    rootId = root.id;
    passwordHash = root.passwordHash;
    adminId = (await db.user.create({ data: { email: 'admin@bindings.test', passwordHash: root.passwordHash, role: 'MEMBER' } })).id;
    targetId = (await db.user.create({ data: { email: 'target@bindings.test', passwordHash: root.passwordHash, role: 'MEMBER' } })).id;
    adminToken = await loginToken(server, 'admin@bindings.test');
    targetToken = await loginToken(server, 'target@bindings.test');
  });
  beforeEach(async () => {
    resetThrottle(app);
    const slug = `bindings-${++seq}`;
    projectId = (await db.project.create({ data: { name: slug, slug, key: `B${String.fromCharCode(65 + seq)}` } })).id;
    base = `/api/projects/${slug}/members`;
    await bind('project-admin', adminId);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await app?.close(); });

  it('AC-1: adds a developer binding with the caller as granter and no legacy row', async () => {
    const res = await post({ email: 'target@bindings.test', roleKey: 'developer' }).expect(201);
    expect(data<{ role: string }>(res).role).toBe('DEVELOPER');
    expect(await bindings()).toEqual([expect.objectContaining({ role: expect.objectContaining({ key: 'developer' }), grantedByType: 'USER', grantedById: adminId })]);
    expect(await legacyCount()).toBe(0);
  });
  it('AC-2: defaults to a viewer binding', async () => {
    await post({ email: 'target@bindings.test' }).expect(201);
    expect((await bindings()).map(b => b.role.key)).toEqual(['viewer']);
  });
  it('AC-3: binding-only duplicate is members conflict and adds nothing', async () => {
    await bind('reviewer');
    conflict(await post({ email: 'target@bindings.test', roleKey: 'developer' }), 'members');
    expect((await bindings()).map(b => b.role.key)).toEqual(['reviewer']);
  });
  it('AC-4: concurrent invites add one binding and one MEMBER_ADDED schedule', async () => {
    vi.spyOn(app.get(EmailAvailability), 'configured', 'get').mockReturnValue(true);
    const invite = () => request(server).post(base.replace('/members', '/invites')).set(headers()).send({ email: 'target@bindings.test', roleKey: 'developer' });
    const results = (await Promise.all([invite(), invite()])).sort((a, b) => a.status - b.status);
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    expect(data<{ outcome: string }>(results[0]).outcome).toBe('ADDED');
    conflict(results[1], 'invites.memberExists');
    expect(await bindings()).toHaveLength(1);
    expect(await db.emailSchedule.count({ where: { projectId, userId: targetId, kind: 'MEMBER_ADDED' } })).toBe(1);
  });
  it('AC-5: local listing omits legacy-only members, excluding global admin', async () => {
    await db.roleBinding.deleteMany({ where: { projectId, principalId: adminId } });
    await db.projectMember.create({ data: { projectId, userId: adminId, role: 'VIEWER', joinedAt: new Date(0) } });
    await post({ email: 'target@bindings.test' }, rootToken).expect(201);
    expect(await legacyCount()).toBe(0);
    const page = data<{ total: number; records: { userId: string }[] }>(await request(server).get(base).set(headers(rootToken)).expect(200));
    expect(page.total).toBe(1);
    expect(page.records.map(m => m.userId)).toEqual([targetId]);
    expect(page.records.map(m => m.userId)).not.toContain(rootId);
  });
  it('AC-6: role replacement preserves reviewer', async () => {
    await bind('developer'); await bind('reviewer');
    // Permissions P1 US-003: a role change is a grant of the new binding plus a delete of the old one
    // on the role-bindings route.
    await request(server).post('/api/role-bindings').set(headers())
      .send({ principalType: 'USER', principalId: targetId, roleKey: 'project-admin', projectId }).expect(201);
    const developer = await db.roleBinding.findFirstOrThrow({
      where: { principalId: targetId, principalType: 'USER', projectId, role: { key: 'developer' } },
    });
    await request(server).delete(`/api/role-bindings/${developer.id}`).set(headers()).expect(204);
    expect((await bindings()).map(b => b.role.key).sort()).toEqual(['project-admin', 'reviewer']);
  });
  it('AC-7: a legacy-only member holds no binding, so no role change reaches it', async () => {
    await db.projectMember.create({ data: { projectId, userId: targetId, role: 'DEVELOPER' } });
    // The retired members PATCH cannot change it …
    await request(server).patch(`${base}/${targetId}`).set(headers())
      .send({ role: 'VIEWER' }).expect(404);
    // … and the role-bindings route has nothing of this member's to change.
    expect(await bindings()).toEqual([]);
    expect(await legacyCount()).toBe(1);
  });
  it('AC-8: the last admin binding cannot be revoked by a caller without global authority', async () => {
    // A caller holding every *project* key but not `role.binding.global` (a GLOBAL key no PROJECT role
    // confers): the custom co-admin role carries `*` in the project, so only the last-admin count can
    // refuse the delete.
    const coAdminId = (await db.user.create({
      data: { email: 'co-admin@bindings.test', passwordHash, role: 'MEMBER' },
    })).id;
    const coAdminRole = await db.role.create({
      data: {
        key: `co-admin-${projectId}`, name: 'Co Admin', description: '', scope: 'PROJECT',
        system: false, locked: false, permissions: ['*'],
      },
    });
    await db.roleBinding.create({
      data: {
        principalType: 'USER', principalId: coAdminId, projectId,
        roleId: coAdminRole.id, grantedByType: 'SYSTEM', grantedById: 'test',
      },
    });
    const coAdminToken = await loginToken(server, 'co-admin@bindings.test');
    const admin = await db.roleBinding.findFirstOrThrow({
      where: { principalId: adminId, principalType: 'USER', projectId, role: { key: 'project-admin' } },
    });

    conflict(await request(server).delete(`/api/role-bindings/${admin.id}`).set(headers(coAdminToken)), 'members.lastAdmin');
    expect((await bindings(adminId)).map(b => b.role.key)).toEqual(['project-admin']);
  });
  it('AC-9: removal deletes the member\'s bindings and revokes project access', async () => {
    await db.projectMember.create({ data: { projectId, userId: targetId, role: 'DEVELOPER' } });
    await bind('developer'); await bind('reviewer');
    for (const binding of await bindings()) {
      await request(server).delete(`/api/role-bindings/${binding.id}`).set(headers()).expect(204);
    }
    expect(await bindings()).toHaveLength(0);
    await request(server).get(base.replace('/members', '/tickets')).set(headers(targetToken)).expect(403);
  });
  it('AC-10: revoking no binding is the role-bindings 404', async () => {
    const res = await request(server).delete('/api/role-bindings/no-such-binding').set(headers()).expect(404);
    expect(res.body.ret).not.toBe(0);
  });
  it('AC-11: existing-user invite grants developer with caller attribution', async () => {
    const res = await request(server).post(base.replace('/members', '/invites')).set(headers()).send({ email: 'target@bindings.test', roleKey: 'developer' }).expect(201);
    expect(data(res)).toMatchObject({ outcome: 'ADDED', member: { email: 'target@bindings.test', role: 'DEVELOPER' } });
    expect(await bindings()).toEqual([expect.objectContaining({ grantedById: adminId, role: expect.objectContaining({ key: 'developer' }) })]);
    expect(await legacyCount()).toBe(0);
  });
  it('AC-12: existing-user invite refuses a binding-only member', async () => {
    await bind('viewer');
    conflict(await request(server).post(base.replace('/members', '/invites')).set(headers()).send({ email: 'target@bindings.test', roleKey: 'developer' }), 'invites.memberExists');
  });
  it('AC-14: a member with no binding is not a member of the project', async () => {
    await db.projectMember.create({ data: { projectId, userId: targetId, role: 'DEVELOPER' } });
    await request(server).patch(`${base}/${targetId}`).set(headers()).send({ role: 'DEVELOPER' }).expect(404);
    expect(await bindings()).toEqual([]);
    const page = data<{ records: { userId: string }[] }>(
      await request(server).get(base).set(headers()).expect(200),
    );
    expect(page.records.map(m => m.userId)).not.toContain(targetId);
  });
  it.each([
    { source: 'binding-only', legacyAt: null, bindingAt: new Date('2002-01-01'), since: new Date('2002-01-01') },
    { source: 'binding-earliest', legacyAt: new Date('2002-01-01'), bindingAt: new Date('2001-01-01'), since: new Date('2001-01-01') },
  ])('F1: finds and mutates a $source member beyond the project listing cap', async ({ legacyAt, bindingAt, since }) => {
    const fillerIds = Array.from({ length: MEMBERSHIP_READ_CAP }, (_, i) => `${projectId}-filler-${i}`);
    const developerId = (await db.role.findUniqueOrThrow({ where: { key: 'developer' } })).id;
    const fillerAt = new Date('2000-01-01');
    await db.user.createMany({ data: fillerIds.map(id => ({ id, email: `${id}@bindings.test`, passwordHash: 'unused' })) });
    // Fill both underlying listing sources so the target is outside either capped read.
    await db.projectMember.createMany({ data: fillerIds.map(userId => ({ projectId, userId, role: 'VIEWER', joinedAt: fillerAt })) });
    await db.roleBinding.createMany({ data: fillerIds.map(principalId => ({
      projectId, principalId, principalType: 'USER', roleId: developerId,
      grantedByType: 'SYSTEM', grantedById: 'test', createdAt: fillerAt,
    })) });
    if (legacyAt) await db.projectMember.create({ data: { projectId, userId: targetId, role: 'DEVELOPER', joinedAt: legacyAt } });
    if (bindingAt) await db.roleBinding.create({ data: {
      projectId, principalId: targetId, principalType: 'USER', roleId: developerId,
      grantedByType: 'SYSTEM', grantedById: 'test', createdAt: bindingAt,
    } });

    expect(await app.get(PrismaProjectMembersRepository).findMember(projectId, targetId)).toMatchObject({
      userId: targetId, role: 'DEVELOPER', joinedAt: since,
    });
    conflict(await post({ email: 'target@bindings.test' }), 'members');
    // F1: the member is beyond the project listing cap, so it cannot appear in the members page …
    const listed = data<{ records: { userId: string }[] }>(
      await request(server).get(`${base}?size=100&current=1`).set(headers()).expect(200),
    );
    expect(listed.records.map(record => record.userId)).not.toContain(targetId);
    // … and its bindings are revoked by the principal-filtered binding listing, which is keyed by the
    // member rather than by the project.
    const found = data<{ records: { id: string }[] }>(
      await request(server)
        .get(`/api/role-bindings?principalType=USER&principalId=${targetId}&projectId=${projectId}`)
        .set(headers(rootToken))
        .expect(200),
    );
    expect(found.records.length).toBeGreaterThan(0);
    for (const binding of found.records) {
      await request(server).delete(`/api/role-bindings/${binding.id}`).set(headers(rootToken)).expect(204);
    }
    expect(await bindings()).toHaveLength(0);
  });

  it('AC-15: concurrent member adds yield one binding and one members conflict', async () => {
    const results = (await Promise.all([post({ email: 'target@bindings.test' }), post({ email: 'target@bindings.test' })])).sort((a, b) => a.status - b.status);
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    conflict(results[1], 'members');
    expect(await bindings()).toHaveLength(1);
  });
});

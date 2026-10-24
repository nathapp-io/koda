import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
describeIntegration('US-007 audited roles, bindings and members', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let token: string;
  let projectId: string;
  let next = 0;
  const auth = (value = token) => ({ Authorization: `Bearer ${value}` });
  const rows = (resourceId: string) => db.auditEntry.findMany({ where: { resourceId }, orderBy: { createdAt: 'asc' } });
  const user = async () => {
    const email = `audit007-${++next}@koda.test`;
    const response = await request(server).post('/api/admin/users').set(auth()).send({ email, name: email, password: TEST_PASSWORD }).expect(201);
    return { id: data<{ id: string }>(response).id, email };
  };
  const role = async () => {
    const key = `audit-role-${++next}`;
    const response = await request(server).post('/api/roles').set(auth()).send({ key, name: key, scope: 'PROJECT', permissions: ['project.read'] }).expect(201);
    return data<{ id: string; key: string }>(response);
  };
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    server = app.getHttpServer();
    db = fixtureDb(app);
    const registered = await request(server).post('/api/auth/register').send({ email: 'audit007-owner@koda.test', name: 'Owner', password: TEST_PASSWORD }).expect(201);
    token = data<{ accessToken: string }>(registered).accessToken;
    const project = await request(server).post('/api/projects').set(auth()).send({ name: 'Audit roles', slug: 'audit-roles', key: 'ARL' }).expect(201);
    projectId = data<{ id: string }>(project).id;
  }, 60_000);
  afterAll(async () => { await app?.close(); });

  it('AC-1/2: owner role POST returns 201 and records the created key', async () => {
    const created = await role();
    expect(await rows(created.id)).toEqual([expect.objectContaining({ key: 'role.manage', resourceType: 'role', resourceId: created.id, projectId: null, summary: `created ${created.key}` })]);
  });
  it('AC-3: custom role PATCH records fields only', async () => {
    const created = await role();
    await request(server).patch(`/api/roles/${created.id}`).set(auth()).send({ name: 'Renamed' }).expect(200);
    expect((await rows(created.id)).filter(row => row.summary === 'fields: name')).toEqual([expect.objectContaining({ key: 'role.manage' })]);
  });
  it('AC-4: unbound role DELETE records the deleted key', async () => {
    const created = await role();
    await request(server).delete(`/api/roles/${created.id}`).set(auth()).expect(204);
    expect((await rows(created.id)).filter(row => row.summary === `deleted ${created.key}`)).toEqual([expect.objectContaining({ key: 'role.manage' })]);
  });
  it.each([
    ['AC-5/18/19', 'viewer', true, 'role.binding.manage'],
    ['AC-6', 'admin', false, 'role.binding.global'],
    ['AC-7', 'owner', false, 'role.binding.owner'],
  ])('%s: binding POST records the most specific key, not repeated no-ops', async (_ac, roleKey, scoped, key) => {
    const target = await user();
    const body = { principalType: 'USER', principalId: target.id, roleKey, ...(scoped ? { projectId } : {}) };
    const response = await request(server).post('/api/role-bindings').set(auth()).send(body).expect(201);
    const binding = data<{ id: string }>(response);
    const repeated = await request(server).post('/api/role-bindings').set(auth()).send(body).expect(201);
    expect(data<{ id: string }>(repeated).id).toBe(binding.id);
    expect(await rows(binding.id)).toEqual([expect.objectContaining({ key, resourceType: 'role-binding', projectId: scoped ? projectId : null, summary: `${roleKey} to USER ${target.id}` })]);
  });
  it('AC-8: binding DELETE records from the stored binding', async () => {
    const target = await user();
    const binding = await grantRole(db, { type: 'USER', id: target.id }, 'viewer', projectId);
    await request(server).delete(`/api/role-bindings/${binding.id}`).set(auth()).expect(204);
    expect(await rows(binding.id)).toEqual([expect.objectContaining({ key: 'role.binding.manage', summary: `viewer from USER ${target.id}` })]);
  });
  it('AC-9/10: last Project Admin refusal records nothing', async () => {
    const target = await user();
    const actor = await user();
    const binding = await grantRole(db, { type: 'USER', id: target.id }, 'project-admin', projectId);
    const custom = await db.role.create({ data: { key: 'audit-binding-manager', name: 'Manager', scope: 'PROJECT', permissions: ['*'] } });
    await grantRole(db, { type: 'USER', id: actor.id }, custom.key, projectId);
    const actorToken = await loginToken(server, actor.email);
    await request(server).delete(`/api/role-bindings/${binding.id}`).set(auth(actorToken)).expect(409);
    expect(await rows(binding.id)).toHaveLength(0);
  });
  it('AC-20/21/22: member POST returns 201 and records only member.add', async () => {
    const target = await user();
    await request(server).post('/api/projects/audit-roles/members').set(auth()).send({ email: target.email, roleKey: 'viewer' }).expect(201);
    const binding = await db.roleBinding.findFirstOrThrow({ where: { principalId: target.id, projectId } });
    expect(await rows(binding.id)).toEqual([expect.objectContaining({ key: 'member.add', resourceType: 'role-binding', resourceId: binding.id, projectId, summary: `viewer to USER ${target.id}` })]);
  });
  it('AC-23: empty role PATCH adds no entry', async () => {
    const created = await role();
    const before = await rows(created.id);
    await request(server).patch(`/api/roles/${created.id}`).set(auth()).send({}).expect(200);
    expect(await rows(created.id)).toEqual(before);
  });
});

import { canRunDbTests } from '../../helpers/test-environment';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, TEST_PASSWORD } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
describeIntegration('US-007 audited roles, bindings and members', () => {
  let app: NathApplication;
  let http: FastifyInstance;
  let db: PrismaClient;
  let token: string;
  let projectId: string;
  let next = 0;
  // Inject through the real Fastify/Nest pipeline without opening a loopback socket. Environment
  // proxies and sandbox egress interception must not decide the result of these database tests.
  const api = async <T = unknown>(method: HTTPMethods, url: string, status: number,
    payload?: Record<string, unknown>, accessToken = token): Promise<T> => {
    expect(http.server.listening).toBe(false);
    const response = await http.inject({
      method, url, payload, headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
    });
    expect(response.statusCode, response.body).toBe(status);
    if (status === 204) {
      expect(response.body).toBe('');
      return undefined as T;
    }
    const body = response.json<{ ret: number; data: T }>();
    expect(body.ret).toBe(status === 409 ? 409 : 0);
    return body.data;
  };
  const rows = (resourceId: string) => db.auditEntry.findMany({ where: { resourceId }, orderBy: { createdAt: 'asc' } });
  const user = async () => {
    const email = `audit007-${++next}@koda.test`;
    const created = await api<{ id: string }>('POST', '/api/admin/users', 201, { email, name: email, password: TEST_PASSWORD });
    return { id: created.id, email };
  };
  const role = async () => {
    const key = `audit-role-${++next}`;
    return api<{ id: string; key: string }>('POST', '/api/roles', 201, { key, name: key, scope: 'PROJECT', permissions: ['project.read'] });
  };
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null, adapter: 'fastify' });
    http = app.getHttpAdapter().getInstance<FastifyInstance>();
    db = fixtureDb(app);
    const registered = await api<{ accessToken: string }>('POST', '/api/auth/register', 201, {
      email: 'audit007-owner@koda.test', name: 'Owner', password: TEST_PASSWORD,
    }, '');
    token = registered.accessToken;
    const project = await api<{ id: string }>('POST', '/api/projects', 201, { name: 'Audit roles', slug: 'audit-roles', key: 'ARL' });
    projectId = project.id;
  }, 60_000);
  afterAll(async () => { await app?.close(); });

  it('AC-1/2: owner role POST returns 201 and records the created key', async () => {
    const created = await role();
    expect(await rows(created.id)).toEqual([expect.objectContaining({ key: 'role.manage', resourceType: 'role', resourceId: created.id, projectId: null, summary: `created ${created.key}` })]);
  });
  it('AC-3: custom role PATCH records fields only', async () => {
    const created = await role();
    await api('PATCH', `/api/roles/${created.id}`, 200, { name: 'Renamed' });
    expect((await rows(created.id)).filter(row => row.summary === 'fields: name')).toEqual([expect.objectContaining({ key: 'role.manage' })]);
  });
  it('AC-4: unbound role DELETE records the deleted key', async () => {
    const created = await role();
    await api('DELETE', `/api/roles/${created.id}`, 204);
    expect((await rows(created.id)).filter(row => row.summary === `deleted ${created.key}`)).toEqual([expect.objectContaining({ key: 'role.manage' })]);
  });
  it.each([
    ['AC-5/18/19', 'viewer', true, 'role.binding.manage'],
    ['AC-6', 'admin', false, 'role.binding.global'],
    ['AC-7', 'owner', false, 'role.binding.owner'],
  ])('%s: binding POST records the most specific key, not repeated no-ops', async (_ac, roleKey, scoped, key) => {
    const target = await user();
    const body = { principalType: 'USER', principalId: target.id, roleKey, ...(scoped ? { projectId } : {}) };
    const binding = await api<{ id: string }>('POST', '/api/role-bindings', 201, body);
    const repeated = await api<{ id: string }>('POST', '/api/role-bindings', 201, body);
    expect(repeated.id).toBe(binding.id);
    expect(await rows(binding.id)).toEqual([expect.objectContaining({ key, resourceType: 'role-binding', projectId: scoped ? projectId : null, summary: `${roleKey} to USER ${target.id}` })]);
  });
  it('AC-8: binding DELETE records from the stored binding', async () => {
    const target = await user();
    const binding = await grantRole(db, { type: 'USER', id: target.id }, 'viewer', projectId);
    await api('DELETE', `/api/role-bindings/${binding.id}`, 204);
    expect(await rows(binding.id)).toEqual([expect.objectContaining({ key: 'role.binding.manage', summary: `viewer from USER ${target.id}` })]);
  });
  it('AC-9/10: last Project Admin refusal records nothing', async () => {
    const target = await user();
    const actor = await user();
    const binding = await grantRole(db, { type: 'USER', id: target.id }, 'project-admin', projectId);
    const custom = await db.role.create({ data: { key: 'audit-binding-manager', name: 'Manager', scope: 'PROJECT', permissions: ['*'] } });
    await grantRole(db, { type: 'USER', id: actor.id }, custom.key, projectId);
    const login = await api<{ accessToken: string }>('POST', '/api/auth/login', 200, { email: actor.email, password: TEST_PASSWORD }, '');
    await api('DELETE', `/api/role-bindings/${binding.id}`, 409, undefined, login.accessToken);
    expect(await rows(binding.id)).toHaveLength(0);
  });
  it('AC-20/21/22: member POST returns 201 and records only member.add', async () => {
    const target = await user();
    await api('POST', '/api/projects/audit-roles/members', 201, { email: target.email, roleKey: 'viewer' });
    const binding = await db.roleBinding.findFirstOrThrow({ where: { principalId: target.id, projectId } });
    expect(await rows(binding.id)).toEqual([expect.objectContaining({ key: 'member.add', resourceType: 'role-binding', resourceId: binding.id, projectId, summary: `viewer to USER ${target.id}` })]);
  });
  it('AC-23: empty role PATCH adds no entry', async () => {
    const created = await role();
    const before = await rows(created.id);
    await api('PATCH', `/api/roles/${created.id}`, 200, {});
    expect(await rows(created.id)).toEqual(before);
  });
});

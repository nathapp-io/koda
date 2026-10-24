import { canRunDbTests } from '../../helpers/test-environment';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { PrismaProjectInvitesRepository } from '../../../src/projects/invites/prisma-project-invites.repository';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
describeIntegration('audited invites, public registration and admin users', () => {
  let app: NathApplication;
  let http: FastifyInstance;
  let db: PrismaClient;
  let token: string;
  let adminId: string;
  let projectId: string;
  let next = 0;
  const invitesUrl = '/api/projects/audit-invites/invites';
  const api = async <T = unknown>(method: HTTPMethods, url: string, status: number,
    payload?: Record<string, unknown>, accessToken = token): Promise<T> => {
    resetThrottle(app);
    const response = await http.inject({ method, url, payload,
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {} });
    expect(response.statusCode, response.body).toBe(status);
    if (status === 204) return undefined as T;
    const body = response.json<{ ret: number; data: T }>();
    if (status < 400) expect(body.ret).toBe(0);
    return body.data;
  };
  const rows = (resourceId: string) => db.auditEntry.findMany({ where: { resourceId }, take: 100 });
  const account = () => ({ email: `audit008-${++next}@koda.test`, name: `Private Name ${next}`, password: TEST_PASSWORD });
  const user = async () => {
    const body = account();
    const created = await api<{ id: string }>('POST', '/api/admin/users', 201, body);
    return { ...body, id: created.id };
  };
  const invite = async () => {
    const body = { email: `invite008-${++next}@koda.test`, roleKey: 'viewer' };
    const result = await api<{ invite: { id: string }; invitePath: string }>('POST', invitesUrl, 201, body);
    return { ...result, ...body, raw: result.invitePath.split('/').pop() ?? '' };
  };
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null, adapter: 'fastify' });
    http = app.getHttpAdapter().getInstance<FastifyInstance>();
    db = fixtureDb(app);
    const root = await api<{ accessToken: string; user: { id: string } }>('POST', '/api/auth/register', 201,
      { email: 'audit008-owner@koda.test', name: 'Owner', password: TEST_PASSWORD }, '');
    token = root.accessToken;
    adminId = root.user.id;
    const project = await api<{ id: string }>('POST', '/api/projects', 201,
      { name: 'Audit invites', slug: 'audit-invites', key: 'AIN' });
    projectId = project.id;
  }, 60_000);
  afterAll(async () => { await app?.close(); });

  it('writes require action context', async () => { await expectGuardActive(app); });
  it('AC-1/2/3: new-address POST records one safe invite.create', async () => {
    const created = await invite();
    const entries = await rows(created.invite.id);
    expect(entries).toEqual([expect.objectContaining({ key: 'invite.create', resourceType: 'project-invite',
      projectId, summary: 'viewer invited' })]);
    expect(entries[0].summary).not.toContain(created.email);
    expect(entries[0].summary).not.toContain(created.raw);
  });
  it('AC-4: existing-account POST records the binding, not another binding action', async () => {
    const target = await user();
    await api('POST', invitesUrl, 201, { email: target.email, roleKey: 'viewer' });
    const binding = await db.roleBinding.findFirstOrThrow({ where: { principalId: target.id, projectId } });
    expect(await rows(binding.id)).toEqual([expect.objectContaining({ key: 'invite.create', resourceType: 'role-binding',
      resourceId: binding.id, projectId, summary: `viewer to USER ${target.id}` })]);
  });
  it.each(['resend', 'cancel'] as const)('AC-5/6: %s records one invite entry', async method => {
    const created = await invite();
    await api(method === 'resend' ? 'POST' : 'DELETE', `${invitesUrl}/${created.invite.id}${method === 'resend' ? '/resend' : ''}`, 200);
    expect((await rows(created.invite.id)).filter(row => row.key === `invite.${method}`)).toEqual([
      expect.objectContaining({ resourceType: 'project-invite', projectId, summary: method === 'resend' ? 'resent' : 'cancelled' }),
    ]);
  });
  it('AC-9/10/11/12: public accept records anonymous once, including after replay', async () => {
    const created = await invite();
    const url = `/api/invites/${created.raw}/accept`;
    const accepted = await api<{ user: { id: string } }>('POST', url, 201, { name: 'Private Accept', password: TEST_PASSWORD }, '');
    const expected = [expect.objectContaining({ key: 'invite.accept', resourceType: 'project-invite', projectId,
      actorType: 'SYSTEM', actorId: 'anonymous', summary: `accepted by USER ${accepted.user.id}` })];
    expect((await rows(created.invite.id)).filter(row => row.key === 'invite.accept')).toEqual(expected);
    await api('POST', url, 404, { password: TEST_PASSWORD }, '');
    expect((await rows(created.invite.id)).filter(row => row.key === 'invite.accept')).toEqual(expected);
  });
  it('AC-13/14/18: public registration records anonymous with no account secrets', async () => {
    const body = account();
    const created = await api<{ user: { id: string } }>('POST', '/api/auth/register', 201, body, '');
    const entries = await rows(created.user.id);
    expect(entries).toEqual([expect.objectContaining({ key: 'auth.register', resourceType: 'user', projectId: null,
      actorType: 'SYSTEM', actorId: 'anonymous', summary: 'registered' })]);
    for (const secret of Object.values(body)) expect(entries[0].summary).not.toContain(secret);
  });
  it('AC-15/16/18: global admin create records the acting admin and no account secrets', async () => {
    // Use the seeded admin role, not the bootstrap owner role, for the caller under test.
    const admin = await user();
    await grantRole(db, { type: 'USER', id: admin.id }, 'admin', null);
    const login = await api<{ accessToken: string }>('POST', '/api/auth/login', 200, { email: admin.email, password: TEST_PASSWORD }, '');
    const body = account();
    const created = await api<{ id: string }>('POST', '/api/admin/users', 201, body, login.accessToken);
    const entries = await rows(created.id);
    expect(entries).toEqual([expect.objectContaining({ key: 'user.create', resourceType: 'user', projectId: null,
      actorType: 'USER', actorId: admin.id, summary: 'created' })]);
    for (const secret of Object.values(body)) expect(entries[0].summary).not.toContain(secret);
  });
  it('AC-17: admin disable records fields only', async () => {
    const target = await user();
    await api('PATCH', `/api/admin/users/${target.id}`, 200, { disabled: true });
    expect((await rows(target.id)).filter(row => row.key === 'user.update')).toEqual([
      expect.objectContaining({ actorType: 'USER', actorId: adminId, summary: 'fields: disabled' }),
    ]);
  });
  it('AC-19/20: refused user.create records nothing', async () => {
    const member = await user();
    const login = await api<{ accessToken: string }>('POST', '/api/auth/login', 200, { email: member.email, password: TEST_PASSWORD }, '');
    const before = await db.auditEntry.count({ where: { key: 'user.create' } });
    const body = account();
    await api('POST', '/api/admin/users', 403, body, login.accessToken);
    expect(await db.auditEntry.count({ where: { key: 'user.create' } })).toBe(before);
    expect(await db.user.count({ where: { email: body.email } })).toBe(0);
  });
  it.each(['resend', 'cancel'] as const)('AC-21: lost %s write after PENDING guard returns 409 without audit', async method => {
    const created = await invite();
    const repo = app.get(PrismaProjectInvitesRepository, { strict: false });
    const spy = method === 'resend' ? vi.spyOn(repo, 'rotate').mockResolvedValueOnce(null)
      : vi.spyOn(repo, 'cancel').mockResolvedValueOnce(false);
    try {
      await api(method === 'resend' ? 'POST' : 'DELETE', `${invitesUrl}/${created.invite.id}${method === 'resend' ? '/resend' : ''}`, 409);
      expect(spy).toHaveBeenCalledTimes(1);
      expect((await rows(created.invite.id)).filter(row => row.key === `invite.${method}`)).toEqual([]);
      expect((await db.projectInvite.findUniqueOrThrow({ where: { id: created.invite.id } })).status).toBe('PENDING');
    } finally { spy.mockRestore(); }
  });
});

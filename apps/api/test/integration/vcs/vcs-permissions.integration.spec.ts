import { createHmac } from 'node:crypto';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { createTestPrismaClient } from '../../helpers/test-prisma';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const BASE = '/api/projects/p1/vcs';
const CREATE = {
  provider: 'github', repoOwner: 'acme', repoName: 'widgets', token: 'ghp_test', syncMode: 'webhook',
};

describeIntegration('VCS permission keys over HTTP (binding-only principals)', () => {
  vi.setConfig({ testTimeout: 60000 });
  let app: NathApplication;
  let server: Parameters<typeof request>[0];
  let prisma: PrismaClient;
  let projectId: string;
  const tokens: Record<string, string> = {};
  const previousKey = process.env.VCS_ENCRYPTION_KEY;
  const previousScoping = process.env.AGENT_PROJECT_SCOPING;
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const connection = () => prisma.vcsConnection.findUniqueOrThrow({ where: { projectId } });
  const refused = (response: request.Response, domain = 'permissions') => {
    expect(response.body).toMatchObject({ ret: 40003 });
    expect(response.body.message).toContain(domain);
  };

  beforeAll(async () => {
    await resetDb();
    process.env.VCS_ENCRYPTION_KEY = 'ab'.repeat(32);
    process.env.AGENT_PROJECT_SCOPING = 'on';
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = createTestPrismaClient(process.env.DATABASE_URL);
    const root = await request(server).post('/api/auth/register')
      .send({ email: 'vcs-root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;
    await request(server).post('/api/projects').set(auth('root'))
      .send({ name: 'P1', slug: 'p1', key: 'PONE' }).expect(201);
    projectId = (await prisma.project.findUniqueOrThrow({ where: { slug: 'p1' } })).id;
    const grantor = await prisma.user.findUniqueOrThrow({ where: { email: 'vcs-root@koda.test' } });

    for (const [who, roleKey] of [
      ['admin', 'project-admin'], ['developer', 'developer'], ['viewer', 'viewer'], ['outsider', null],
    ] as const) {
      resetThrottle(app);
      await request(server).post('/api/admin/users').set(auth('root'))
        .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
      tokens[who] = await loginToken(server, `${who}@koda.test`);
      const user = await prisma.user.findUniqueOrThrow({ where: { email: `${who}@koda.test` } });
      expect(user.role).toBe('MEMBER');
      // User creation also grants the global member role; remove it so this
      // fixture exercises only the explicit project binding (or no binding).
      await prisma.roleBinding.deleteMany({ where: { principalType: 'USER', principalId: user.id } });
      expect(await prisma.projectMember.count({ where: { userId: user.id } })).toBe(0);
      if (roleKey) {
        const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
        await prisma.roleBinding.create({ data: {
          principalType: 'USER', principalId: user.id, roleId: role.id, projectId,
          grantedByType: 'USER', grantedById: grantor.id,
        } });
      }
      expect(await prisma.roleBinding.count({ where: { principalType: 'USER', principalId: user.id } }))
        .toBe(roleKey ? 1 : 0);
    }
    for (const [who, roleKey] of [['admin-agent', 'project-admin'], ['developer-agent', 'developer']] as const) {
      const response = await request(server).post('/api/agents').set(auth('root'))
        .send({ name: who, slug: who }).expect(201);
      tokens[who] = data<{ apiKey: string }>(response).apiKey;
      const agent = await prisma.agent.findUniqueOrThrow({ where: { slug: who } });
      await prisma.roleBinding.deleteMany({ where: { principalType: 'AGENT', principalId: agent.id } });
      expect(await prisma.agentProject.count({ where: { agentId: agent.id } })).toBe(0);
      expect(await prisma.agentRoleEntry.count({ where: { agentId: agent.id } })).toBe(0);
      const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
      await prisma.roleBinding.create({ data: {
        principalType: 'AGENT', principalId: agent.id, roleId: role.id, projectId,
        grantedByType: 'USER', grantedById: grantor.id,
      } });
      expect(await prisma.roleBinding.count({ where: { principalType: 'AGENT', principalId: agent.id } })).toBe(1);
    }
  });

  beforeEach(async () => {
    resetThrottle(app);
    await prisma.vcsSyncLog.deleteMany({ where: { vcsConnection: { projectId } } });
    await prisma.vcsConnection.deleteMany({ where: { projectId } });
    await request(server).post(BASE).set(auth('root')).send(CREATE).expect(201);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
    if (previousKey === undefined) delete process.env.VCS_ENCRYPTION_KEY;
    else process.env.VCS_ENCRYPTION_KEY = previousKey;
    if (previousScoping === undefined) delete process.env.AGENT_PROJECT_SCOPING;
    else process.env.AGENT_PROJECT_SCOPING = previousScoping;
  });

  it('AC-1: project-admin binding creates a connection and receives its secret', async () => {
    await prisma.vcsConnection.deleteMany({ where: { projectId } });
    const response = await request(server).post(BASE).set(auth('admin')).send(CREATE).expect(201);
    const secret = data<{ webhookSecret: string }>(response).webhookSecret;
    expect(secret).toMatch(/^[0-9a-f]{32}$/);
    expect((await connection()).webhookSecret).toBe(secret);
  });

  it('AC-2: viewer binding reads configuration without credentials', async () => {
    const response = await request(server).get(BASE).set(auth('viewer')).expect(200);
    const body = data<Record<string, unknown>>(response);
    expect(body.webhookSecretConfigured).toBe(true);
    expect(body).not.toHaveProperty('webhookSecret');
    expect(body).not.toHaveProperty('encryptedToken');
    expect(body).not.toHaveProperty('token');
  });

  it('AC-3: developer cannot update, leaving stored sync mode unchanged', async () => {
    const before = await connection();
    refused(await request(server).patch(BASE).set(auth('developer')).send({ syncMode: 'polling' }).expect(403));
    expect((await connection()).syncMode).toBe(before.syncMode);
  });

  it('AC-4: project-admin binding updates stored sync mode', async () => {
    await request(server).patch(BASE).set(auth('admin')).send({ syncMode: 'polling' }).expect(200);
    expect((await connection()).syncMode).toBe('polling');
  });

  it('AC-5: developer cannot delete the connection', async () => {
    const before = await connection();
    refused(await request(server).delete(BASE).set(auth('developer')).expect(403));
    expect((await connection()).id).toBe(before.id);
  });

  it('AC-6: project-admin binding deletes the connection', async () => {
    await request(server).delete(BASE).set(auth('admin')).expect(204);
    expect(await prisma.vcsConnection.findUnique({ where: { projectId } })).toBeNull();
  });

  it.each([
    [7, '/test'], [9, '/sync/1'], [10, '/sync-pr'],
  ])('AC-%s: developer is refused POST %s', async (_ac, path) => {
    refused(await request(server).post(`${BASE}${path}`).set(auth('developer')).expect(403));
  });

  it('AC-8: developer cannot sync or write a VcsSyncLog', async () => {
    expect(await prisma.vcsSyncLog.count({ where: { vcsConnection: { projectId } } })).toBe(0);
    refused(await request(server).post(`${BASE}/sync`).set(auth('developer')).expect(403));
    expect(await prisma.vcsSyncLog.count({ where: { vcsConnection: { projectId } } })).toBe(0);
  });

  it('AC-11: project-admin-bound agent rotates and persists the secret', async () => {
    const before = (await connection()).webhookSecret;
    const response = await request(server).post(`${BASE}/webhook-secret/rotate`).set(auth('admin-agent')).expect(200);
    const secret = data<{ webhookSecret: string }>(response).webhookSecret;
    expect(secret).toMatch(/^[0-9a-f]{32}$/);
    expect(secret).not.toBe(before);
    expect((await connection()).webhookSecret).toBe(secret);
  });

  it('AC-12: developer-bound agent cannot rotate or change the secret', async () => {
    const before = (await connection()).webhookSecret;
    refused(await request(server).post(`${BASE}/webhook-secret/rotate`).set(auth('developer-agent')).expect(403));
    expect((await connection()).webhookSecret).toBe(before);
  });

  it('AC-13: no access fails project membership before permission checking', async () => {
    refused(await request(server).get(BASE).set(auth('outsider')).expect(403), 'projects');
  });

  it('AC-14: public intake accepts a signed payload and ignores polling connections', async () => {
    await prisma.vcsConnection.update({ where: { projectId }, data: { syncMode: 'polling' } });
    const secret = (await connection()).webhookSecret;
    if (!secret) throw new Error('Expected the fixture connection to have a webhook secret');
    const payload = JSON.stringify({ action: 'opened', issue: { number: 1 } });
    const signature = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
    const response = await request(server).post(`${BASE}-webhook`)
      .set('Content-Type', 'application/json').set('x-hub-signature-256', signature)
      .send(payload).expect(200);
    expect(response.body).toMatchObject({ success: true, ignored: true });
  });

  it('AC-15: public intake still rejects a bad signature with vcs_webhook', async () => {
    const response = await request(server).post(`${BASE}-webhook`)
      .set('x-hub-signature-256', `sha256=${'0'.repeat(64)}`).send({ action: 'opened' }).expect(401);
    expect(response.body.message).toContain('vcs_webhook');
    expect(response.body.ret).not.toBe(0);
  });
});

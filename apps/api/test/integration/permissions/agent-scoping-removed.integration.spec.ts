import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { MembershipService } from '../../../src/permissions/membership.service';
import { ProjectAccessService } from '../../../src/projects/project-access.service';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';

const dbDescribe = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

dbDescribe('agent access ignores the retired off flag', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let key: string;
  let agentId: string;
  let p1: string;
  let p2: string;
  let adminToken: string;
  const agentAuth = () => ({ Authorization: `Bearer ${key}` });

  beforeAll(async () => {
    await resetDb();
    const previous = process.env.AGENT_PROJECT_SCOPING;
    process.env.AGENT_PROJECT_SCOPING = 'off';
    try {
      app = await bootHttpApp({ registrationEnabled: false });
    } finally {
      if (previous === undefined) delete process.env.AGENT_PROJECT_SCOPING;
      else process.env.AGENT_PROJECT_SCOPING = previous;
    }
    db = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    const server = app.getHttpServer();
    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    const rootAuth = { Authorization: `Bearer ${data<{ accessToken: string }>(root).accessToken}` };
    for (const [slug, projectKey] of [['p1', 'PAA'], ['p2', 'PAB']]) {
      await request(server).post('/api/projects').set(rootAuth)
        .send({ slug, key: projectKey, name: slug }).expect(201);
    }
    p1 = (await db.project.findUniqueOrThrow({ where: { slug: 'p1' } })).id;
    p2 = (await db.project.findUniqueOrThrow({ where: { slug: 'p2' } })).id;
    const agent = data<{ apiKey: string; agent: { id: string } }>(await request(server)
      .post('/api/agents').set(rootAuth).send({ name: 'Bot', slug: 'scoped-bot' }).expect(201));
    key = agent.apiKey;
    agentId = agent.agent.id;
    const user = data<{ id: string }>(await request(server).post('/api/admin/users').set(rootAuth)
      .send({ email: 'pa@koda.test', name: 'Project Admin', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201));
    await grantRole(db, { type: 'USER', id: user.id }, 'project-admin', p1);
    await app.get(MembershipService).invalidatePermissions();
    adminToken = await loginToken(server, 'pa@koda.test');
  }, 120_000);

  beforeEach(async () => {
    await db.roleBinding.deleteMany({ where: { principalType: 'AGENT', principalId: agentId, role: { scope: 'PROJECT' } } });
    await app.get(MembershipService).invalidatePermissions();
  });

  afterAll(async () => { await app?.close(); });

  it('AC-3: baseline-only agent gets 403 projects with off at boot', async () => {
    const gate = vi.spyOn(app.get(ProjectAccessService), 'resolveMembership');
    try {
      const res = await request(app.getHttpServer()).get('/api/projects/p1').set(agentAuth());
      expect(res.status).toBe(403);
      expect(res.body.ret).toBe(40003);
      // The HTTP filter translates the message; inspect the real gate's rejection to pin its namespace.
      expect(gate).toHaveBeenCalledWith(p1, expect.objectContaining({ id: agentId }));
      await expect(gate.mock.results[0].value).rejects.toMatchObject({ prefix: 'projects', httpStatus: 403 });
    } finally {
      gate.mockRestore();
    }
  });

  it('AC-4: a viewer binding only in P2 lists exactly P2', async () => {
    await grantRole(db, { type: 'AGENT', id: agentId }, 'viewer', p2);
    await app.get(MembershipService).invalidatePermissions();
    const res = await request(app.getHttpServer()).get('/api/projects').set(agentAuth());
    expect(res.status).toBe(200);
    expect(data<{ slug: string }[]>(res).map(({ slug }) => slug)).toEqual(['p2']);
  });

  it('AC-5: viewer in P1 can read P1', async () => {
    await grantRole(db, { type: 'AGENT', id: agentId }, 'viewer', p1);
    await app.get(MembershipService).invalidatePermissions();
    await request(app.getHttpServer()).get('/api/projects/p1').set(agentAuth()).expect(200);
  });

  it('AC-6: project admin sees the roster as { items } alone', async () => {
    const res = await request(app.getHttpServer()).get('/api/projects/p1/agents')
      .set({ Authorization: `Bearer ${adminToken}` }).expect(200);
    // Permissions P1l US-006: `scoping` was always true, so the answer is the items alone.
    const body = data<Record<string, unknown>>(res);
    expect(Object.keys(body)).toEqual(['items']);
    expect(body).not.toHaveProperty('scoping');
  });
});

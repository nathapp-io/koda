import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import type { NathApplication } from '@nathapp/nestjs-app';
import { resetDb } from '../../../test/helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../../test/helpers/http-app';

// HTTP + Postgres acceptance: jest.nax.config.js globalSetup provisions the test DB
// when KODA_DB_TESTS=1. bootHttpApp starts the real Nest/Fastify API with auth,
// project membership guard, global validation pipe, and JSON response envelope.
describe('fleet-s4c-team-access HTTP acceptance', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let projectId: string;
  let projectAdminToken: string;
  const slug = 's4c-acceptance-team';
  const auth = () => ({ Authorization: `Bearer ${projectAdminToken}` });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;

    const root = await request(server).post('/api/auth/register')
      .send({ email: 's4c-root@koda.test', name: 'S4c Root', password: TEST_PASSWORD }).expect(201);
    const rootToken = data<{ accessToken: string }>(root).accessToken;
    const project = await request(server).post('/api/projects')
      .set('Authorization', `Bearer ${rootToken}`)
      .send({ name: 'S4c Acceptance Team', slug, key: 'SAC' }).expect(201);
    projectId = data<{ id: string }>(project).id;

    const admin = await request(server).post('/api/admin/users')
      .set('Authorization', `Bearer ${rootToken}`)
      .send({ email: 's4c-project-admin@koda.test', name: 'Project Admin', password: TEST_PASSWORD, role: 'MEMBER' })
      .expect(201);
    const adminId = data<{ id: string }>(admin).id;
    await prisma.projectMember.create({ data: { projectId, userId: adminId, role: 'ADMIN' } });
    projectAdminToken = await loginToken(server, 's4c-project-admin@koda.test');
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('AC-1: a project ADMIN adds an existing enabled user by email and persists their membership', async () => {
    const email = 's4c-new-member@koda.test';
    const user = await prisma.user.create({ data: {
      email, name: 'New Member', passwordHash: 'not-used-for-login', disabled: false,
    } });
    expect(await prisma.projectMember.findUnique({ where: {
      projectId_userId: { projectId, userId: user.id },
    } })).toBeNull();

    const res = await request(server).post(`/api/projects/${slug}/members`)
      .set(auth()).send({ email });
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    const member = await prisma.projectMember.findUnique({ where: {
      projectId_userId: { projectId, userId: user.id },
    } });
    expect(member).toEqual(expect.objectContaining({ projectId, userId: user.id }));
  });

  it('AC-2: an authorized assignee search rejects limit=0 with HTTP 400 and no items array', async () => {
    const res = await request(server).get(`/api/projects/${slug}/assignees?limit=0`).set(auth());
    expect(res.status).toBe(400);
    expect(Array.isArray(res.body?.items)).toBe(false);
    expect(Array.isArray(res.body?.data?.items)).toBe(false);
  });

  it('AC-3: an authorized assignee search treats URL-decoded percent as a literal substring', async () => {
    const matchingUser = await prisma.user.create({ data: {
      email: 's4c-percent@koda.test', name: 'Percent % Member', passwordHash: 'not-used-for-login', disabled: false,
    } });
    const ordinaryUser = await prisma.user.create({ data: {
      email: 's4c-ordinary@koda.test', name: 'Ordinary Member', passwordHash: 'not-used-for-login', disabled: false,
    } });
    await prisma.projectMember.createMany({ data: [
      { projectId, userId: matchingUser.id, role: 'VIEWER' },
      { projectId, userId: ordinaryUser.id, role: 'VIEWER' },
    ] });
    const matchingAgent = await prisma.agent.create({ data: {
      name: 'Percent % Agent', slug: 's4c-percent-agent', apiKeyHash: 's4c-acceptance-percent-hash', status: 'ACTIVE',
    } });
    const ordinaryAgent = await prisma.agent.create({ data: {
      name: 'Ordinary Agent', slug: 's4c-ordinary-agent', apiKeyHash: 's4c-acceptance-ordinary-hash', status: 'ACTIVE',
    } });
    await prisma.agentProject.createMany({ data: [
      { projectId, agentId: matchingAgent.id }, { projectId, agentId: ordinaryAgent.id },
    ] });

    const res = await request(server).get(`/api/projects/${slug}/assignees?q=%25`).set(auth());
    expect(res.status).toBe(200);
    const result = data<{ items: Array<{ type: string; id: string; name: string; secondary: string }> }>(res);
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'user', id: matchingUser.id }),
      expect.objectContaining({ type: 'agent', id: matchingAgent.id }),
    ]));
    expect(result.items.map((item) => item.id)).not.toContain(ordinaryUser.id);
    expect(result.items.map((item) => item.id)).not.toContain(ordinaryAgent.id);
    for (const item of result.items) {
      expect(['user', 'agent']).toContain(item.type);
      expect(typeof item.name === 'string' && item.name.includes('%') ||
        typeof item.secondary === 'string' && item.secondary.includes('%')).toBe(true);
    }
  });
});
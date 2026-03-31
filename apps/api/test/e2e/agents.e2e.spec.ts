import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { execSync } from 'child_process';
import { AppModule } from '../../src/app.module';
import { AppFactory, NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';
import { CombinedAuthGuard } from '../../src/auth/guards/combined-auth.guard';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = DATABASE_URL ? describe : describe.skip;

function body<T = unknown>(res: request.Response): T {
  expect(res.body).toHaveProperty('ret', 0);
  expect(res.body).toHaveProperty('data');
  return res.body.data as T;
}

describeIntegration('Agents API E2E', () => {
  let app: NathApplication;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;

  let adminAccessToken: string;
  let memberAccessToken: string;
  let projectSlug: string;

  const baseAgentSlug = 'agents-e2e-main';
  let agentSlug = baseAgentSlug;
  let agentApiKey = '';

  beforeAll(async () => {
    if (!DATABASE_URL) return;

    execSync('bunx prisma db push --force-reset --skip-generate', {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL },
    });

    app = await AppFactory.create(AppModule);
    const combinedGuard = app.get(CombinedAuthGuard);
    app.setJwtAuthGuard(combinedGuard);
    app
      .useAppGlobalPrefix()
      .useAppGlobalPipes()
      .useAppGlobalFilters()
      .useAppGlobalGuards();

    await app.init();
    httpServer = app.getHttpServer();

    const adminRegisterRes = await request(httpServer)
      .post('/api/auth/register')
      .send({ email: 'agents-admin@koda.test', name: 'Agents Admin', password: 'Admin1234!' })
      .expect(201);

    const prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
    const adminUser = await prisma.client.user.findUnique({ where: { email: 'agents-admin@koda.test' } });
    expect(adminUser).toBeTruthy();
    await prisma.client.user.update({
      where: { id: (adminUser as NonNullable<typeof adminUser>).id },
      data: { role: 'ADMIN' },
    });

    const adminLoginRes = await request(httpServer)
      .post('/api/auth/login')
      .send({ email: 'agents-admin@koda.test', password: 'Admin1234!' })
      .expect(200);

    adminAccessToken = body<{ accessToken: string }>(adminLoginRes).accessToken;

    const memberRegisterRes = await request(httpServer)
      .post('/api/auth/register')
      .send({ email: 'agents-member@koda.test', name: 'Agents Member', password: 'Member1234!' })
      .expect(201);

    memberAccessToken = body<{ accessToken: string }>(memberRegisterRes).accessToken;

    const projectRes = await request(httpServer)
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ name: 'Agents E2E Project', slug: 'agents-e2e-project', key: 'AEP' })
      .expect(201);

    projectSlug = body<{ slug: string }>(projectRes).slug;
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('POST /api/agents — creates agent with API key (admin only)', async () => {
    const res = await request(httpServer)
      .post('/api/agents')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({
        name: 'Agents E2E Bot',
        slug: baseAgentSlug,
        maxConcurrentTickets: 2,
        roles: ['DEVELOPER', 'REVIEWER'],
        capabilities: ['typescript', 'nestjs'],
      })
      .expect(201);

    const data = body<{ apiKey: string; agent: { slug: string; name: string } }>(res);
    expect(data.apiKey).toBeTruthy();
    expect(data.agent.slug).toBe(baseAgentSlug);
    agentApiKey = data.apiKey;
    agentSlug = data.agent.slug;
  });

  it('POST /api/agents — returns 403 for non-admin user', async () => {
    await request(httpServer)
      .post('/api/agents')
      .set('Authorization', `Bearer ${memberAccessToken}`)
      .send({ name: 'Forbidden', slug: 'forbidden' })
      .expect(403);
  });

  it('GET /api/agents — lists agents', async () => {
    const res = await request(httpServer)
      .get('/api/agents')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);

    const data = body<Array<{ slug: string }>>(res);
    expect(data.some((agent) => agent.slug === agentSlug)).toBe(true);
  });

  it('GET /api/agents/:slug — returns agent details', async () => {
    const res = await request(httpServer)
      .get(`/api/agents/${agentSlug}`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);

    const data = body<{
      slug: string;
      roles: Array<{ role: string }>;
      capabilities: Array<{ capability: string }>;
    }>(res);

    expect(data.slug).toBe(agentSlug);
    expect(data.roles.map((item) => item.role)).toEqual(expect.arrayContaining(['DEVELOPER', 'REVIEWER']));
    expect(data.capabilities.map((item) => item.capability)).toEqual(expect.arrayContaining(['typescript', 'nestjs']));
  });

  it('GET /api/agents/me — returns current agent with API key', async () => {
    const res = await request(httpServer)
      .get('/api/agents/me')
      .set('Authorization', `Bearer ${agentApiKey}`)
      .expect(200);

    const data = body<{ slug: string }>(res);
    expect(data.slug).toBe(agentSlug);
  });

  it('PATCH /api/agents/:slug — updates scalar fields', async () => {
    const res = await request(httpServer)
      .patch(`/api/agents/${agentSlug}`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ name: 'Agents E2E Bot Updated', status: 'PAUSED', maxConcurrentTickets: 4 })
      .expect(200);

    const data = body<{ name: string; status: string; maxConcurrentTickets: number }>(res);
    expect(data.name).toBe('Agents E2E Bot Updated');
    expect(data.status).toBe('PAUSED');
    expect(data.maxConcurrentTickets).toBe(4);
  });

  it('PATCH /api/agents/:slug/update-roles — replaces roles', async () => {
    const res = await request(httpServer)
      .patch(`/api/agents/${agentSlug}/update-roles`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ roles: ['DEVELOPER'] })
      .expect(200);

    const data = body<{ roles: Array<{ role: string }> }>(res);
    expect(data.roles.map((item) => item.role)).toEqual(['DEVELOPER']);
  });

  it('PATCH /api/agents/:slug/update-capabilities — replaces capabilities and removes duplicates', async () => {
    const res = await request(httpServer)
      .patch(`/api/agents/${agentSlug}/update-capabilities`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ capabilities: ['prisma', 'nestjs', 'prisma'] })
      .expect(200);

    const data = body<{ capabilities: Array<{ capability: string }> }>(res);
    const capabilities = data.capabilities.map((item) => item.capability);
    expect(capabilities).toEqual(expect.arrayContaining(['prisma', 'nestjs']));
    expect(capabilities.filter((item) => item === 'prisma')).toHaveLength(1);
  });

  it('POST /api/agents/:slug/rotate-key — rotates key and old key can no longer auth', async () => {
    const oldApiKey = agentApiKey;

    const res = await request(httpServer)
      .post(`/api/agents/${agentSlug}/rotate-key`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);

    const data = body<{ apiKey: string }>(res);
    expect(data.apiKey).toBeTruthy();
    expect(data.apiKey).not.toBe(oldApiKey);
    agentApiKey = data.apiKey;

    await request(httpServer)
      .get('/api/agents/me')
      .set('Authorization', `Bearer ${oldApiKey}`)
      .expect(401);

    await request(httpServer)
      .get('/api/agents/me')
      .set('Authorization', `Bearer ${agentApiKey}`)
      .expect(200);
  });

  it('GET /api/agents/:slug/pickup — returns 400 when project query is missing', async () => {
    await request(httpServer)
      .get(`/api/agents/${agentSlug}/pickup`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(400);
  });

  it('GET /api/agents/:slug/pickup — returns non-null candidate for VERIFIED ticket', async () => {
    const createTicketRes = await request(httpServer)
      .post(`/api/projects/${projectSlug}/tickets`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ type: 'BUG', title: 'Pickup Candidate', priority: 'HIGH' })
      .expect(201);

    const ticketRef = body<{ ref: string }>(createTicketRes).ref;

    await request(httpServer)
      .post(`/api/projects/${projectSlug}/tickets/${ticketRef}/verify`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ body: 'Ready for pickup' })
      .expect(200);

    const pickupRes = await request(httpServer)
      .get(`/api/agents/${agentSlug}/pickup`)
      .query({ project: projectSlug })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);

    const data = body<{ ticket: { ref: string }; matchScore: number; matchedCapabilities: string[] } | null>(pickupRes);
    expect(data).not.toBeNull();
    expect((data as NonNullable<typeof data>).ticket.ref).toBe(ticketRef);
  });

  it('GET /api/agents/:slug/pickup — returns null when project has no verified tickets', async () => {
    const emptyProjectRes = await request(httpServer)
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ name: 'Agents Empty Pickup', slug: 'agents-empty-pickup', key: 'AEM' })
      .expect(201);

    const emptyProjectSlug = body<{ slug: string }>(emptyProjectRes).slug;

    const res = await request(httpServer)
      .get(`/api/agents/${agentSlug}/pickup`)
      .query({ project: emptyProjectSlug })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);

    const data = body<unknown>(res);
    expect(data).toBeNull();
  });

  it('GET /api/agents/:slug/pickup — returns null when project does not exist', async () => {
    const res = await request(httpServer)
      .get(`/api/agents/${agentSlug}/pickup`)
      .query({ project: 'non-existent-project' })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);

    const data = body<unknown>(res);
    expect(data).toBeNull();
  });

  it('DELETE /api/agents/:slug — deletes the agent', async () => {
    const res = await request(httpServer)
      .delete(`/api/agents/${agentSlug}`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);

    const data = body<{ slug: string }>(res);
    expect(data.slug).toBe(agentSlug);
  });

  it('GET /api/agents/:slug — returns 404 after delete', async () => {
    await request(httpServer)
      .get(`/api/agents/${agentSlug}`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(404);
  });
});

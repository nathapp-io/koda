import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { resetDb } from '../helpers/reset-db';
import { AppFactory, NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { CombinedAuthGuard } from '../../src/auth/guards/combined-auth.guard';
import { expectBindingOnlyFixtures, grantRole } from '../../src/permissions/test-helpers/permission-fixtures';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

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
  let adminUserId = '';
  let memberUserId = '';
  let agentId = '';
  /** The projects the agent is rostered in; its project grants follow the roles it acts with. */
  const rosteredProjectIds: string[] = [];
  /**
   * The project role keys the agent acts with. Permissions P1l (US-005): an agent's roles are role
   * bindings, not an `AgentRoleEntry` list, so this is the list of keys `rosterAgentIn` grants rather
   * than legacy role names a create request asked for.
   */
  const agentProjectRoleKeys: string[] = ['developer', 'reviewer'];

  /**
   * Permissions P1 US-005: the roster reach and the roles the agent acts with are role bindings —
   * the `viewer` of the roster plus one binding per project role key, in that project only.
   */
  const rosterAgentIn = async (projectId: string): Promise<void> => {
    const prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    const principal = { type: 'AGENT' as const, id: agentId };
    await grantRole(prisma, principal, 'viewer', projectId);
    for (const roleKey of agentProjectRoleKeys) {
      await grantRole(prisma, principal, roleKey, projectId);
    }
    if (!rosteredProjectIds.includes(projectId)) rosteredProjectIds.push(projectId);
  };

  beforeAll(async () => {
    if (!DATABASE_URL) return;

    await resetDb();

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
      .send({ email: 'agents-admin@koda.test', name: 'Agents Admin', password: 'Admin1234!Aa' })
      .expect(201);

    const prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
    const adminUser = await prisma.client.user.findUnique({ where: { email: 'agents-admin@koda.test' } });
    expect(adminUser).toBeTruthy();
    adminUserId = (adminUser as NonNullable<typeof adminUser>).id;
    // Permissions P1 US-005: the admin's global access is a role binding, not `User { role: 'ADMIN' }`.
    await grantRole(prisma.client, { type: 'USER', id: adminUserId }, 'admin', null);

    const adminLoginRes = await request(httpServer)
      .post('/api/auth/login')
      .send({ email: 'agents-admin@koda.test', password: 'Admin1234!Aa' })
      .expect(200);

    adminAccessToken = body<{ accessToken: string }>(adminLoginRes).accessToken;

    const memberRegisterRes = await request(httpServer)
      .post('/api/auth/register')
      .send({ email: 'agents-member@koda.test', name: 'Agents Member', password: 'Member1234!Aa' })
      .expect(201);

    memberAccessToken = body<{ accessToken: string }>(memberRegisterRes).accessToken;
    const memberUser = await prisma.client.user.findUniqueOrThrow({ where: { email: 'agents-member@koda.test' } });
    memberUserId = memberUser.id;

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
        capabilities: ['typescript', 'nestjs'],
      })
      .expect(201);

    const data = body<{ apiKey: string; agent: { id: string; slug: string; name: string } }>(res);
    expect(data.apiKey).toBeTruthy();
    expect(data.agent.slug).toBe(baseAgentSlug);
    agentApiKey = data.apiKey;
    agentSlug = data.agent.slug;
    agentId = data.agent.id;

    // Permissions P1 US-005: the agent reaches the setup project through the `viewer` binding of its
    // roster, and acts there with a binding per project role key it holds.
    const prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
    const project = await prisma.client.project.findUniqueOrThrow({ where: { slug: projectSlug } });
    await rosterAgentIn(project.id);
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
      capabilities: Array<{ capability: string }>;
    }>(res);

    expect(data.slug).toBe(agentSlug);
    expect(data.capabilities.map((item) => item.capability)).toEqual(expect.arrayContaining(['typescript', 'nestjs']));
    // Permissions P1l US-006: an agent's roles are role bindings, so the profile carries no `roles`.
    expect(data).not.toHaveProperty('roles');
  });

  it('GET /api/agents/me — returns the current agent with its live roster projects (AC15)', async () => {
    // S4c US-001 (AC15): `projects` lists { slug, name } per non-deleted roster
    // project, ordered by slug. `alpha` is rostered after the project created in
    // beforeAll, so a pass cannot come from insertion order, and `zulu` is
    // soft-deleted after its roster row exists, so only the deletedAt filter can
    // keep it out of the list.
    const prisma = app.get<PrismaService<PrismaClient>>(PrismaService);

    const alphaRes = await request(httpServer)
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ name: 'Agents E2E Alpha', slug: 'agents-e2e-alpha', key: 'AEA' })
      .expect(201);
    const alphaSlug = body<{ slug: string }>(alphaRes).slug;
    const alpha = await prisma.client.project.findUniqueOrThrow({ where: { slug: alphaSlug } });

    const zuluRes = await request(httpServer)
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ name: 'Agents E2E Zulu', slug: 'agents-e2e-zulu', key: 'AEZ' })
      .expect(201);
    const zuluSlug = body<{ slug: string }>(zuluRes).slug;
    const zulu = await prisma.client.project.findUniqueOrThrow({ where: { slug: zuluSlug } });

    // Permissions P1 US-005: the roster is a `viewer` binding per project.
    await rosterAgentIn(alpha.id);
    await rosterAgentIn(zulu.id);

    await request(httpServer)
      .delete(`/api/projects/${zuluSlug}`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(204);

    const res = await request(httpServer)
      .get('/api/agents/me')
      .set('Authorization', `Bearer ${agentApiKey}`)
      .expect(200);

    const data = body<{ slug: string; projects: Array<{ slug: string; name: string }> }>(res);
    expect(data.slug).toBe(agentSlug);
    expect(data.projects).toEqual([
      { slug: 'agents-e2e-alpha', name: 'Agents E2E Alpha' },
      { slug: 'agents-e2e-project', name: 'Agents E2E Project' },
    ]);
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

    // S4c US-001: the pickup target needs a roster row on the empty project too
    // (it has no VERIFIED tickets, so pickup returns null rather than 403).
    // Permissions P1 US-005: that roster is a `viewer` binding plus the bindings of the project role
    // keys the agent acts with.
    const prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
    const emptyProject = await prisma.client.project.findUniqueOrThrow({ where: { slug: emptyProjectSlug } });
    await rosterAgentIn(emptyProject.id);

    const res = await request(httpServer)
      .get(`/api/agents/${agentSlug}/pickup`)
      .query({ project: emptyProjectSlug })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);

    const data = body<unknown>(res);
    expect(data).toBeNull();
  });

  it('GET /api/agents/:slug/pickup — returns 404 when project does not exist', async () => {
    await request(httpServer)
      .get(`/api/agents/${agentSlug}/pickup`)
      .query({ project: 'non-existent-project' })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(404);
  });

  it('fixtures grant through bindings only', async () => {
    const prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
    // Permissions P1l (US-005): creation writes no `AgentRoleEntry`, so no exemption is needed —
    // every grant of the agent (baseline, roster viewer and project role keys) is a binding.
    await expectBindingOnlyFixtures(prisma.client, [
      { type: 'USER', id: adminUserId },
      { type: 'USER', id: memberUserId },
      { type: 'AGENT', id: agentId },
    ]);
    // Permissions P1 US-005: the admin's global access is the `admin` binding, not `User.role`.
    const adminBinding = await prisma.client.roleBinding.findFirst({
      where: { principalType: 'USER', principalId: adminUserId, projectId: null, role: { key: 'admin' } },
      select: { id: true },
    });
    expect(adminBinding).not.toBeNull();
    // AC-6: the member holds its member baseline and nothing else, so its POST /api/agents refusal
    // is the non-admin refusal.
    const memberBindings = await prisma.client.roleBinding.findMany({
      where: { principalType: 'USER', principalId: memberUserId },
      include: { role: { select: { key: true } } },
    });
    expect(memberBindings.map((binding) => binding.role.key)).toEqual(['member']);
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

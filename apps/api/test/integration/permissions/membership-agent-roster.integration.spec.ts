import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { MembershipService } from '../../../src/permissions/membership.service';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
interface Agent { id: string; slug: string; apiKey: string }

describeIntegration('agent roster compatibility membership (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let membership: MembershipService;
  let adminToken: string;
  let rootToken: string;
  let adminId: string;
  const projects: Record<string, string> = {};
  const auth = () => ({ Authorization: `Bearer ${adminToken}` });
  const bindings = (agent: Agent) => db.roleBinding.findMany({
    where: { principalType: 'AGENT', principalId: agent.id, projectId: projects.p1 },
    include: { role: true },
  });
  const add = (agent: Agent) => request(server).post('/api/projects/p1/agents').set(auth()).send({ agentSlug: agent.slug });
  const remove = (agent: Agent) => request(server).delete(`/api/projects/p1/agents/${agent.slug}`).set(auth());
  const legacy = (agent: Agent, projectId = projects.p1) => db.agentProject.create({
    data: { agentId: agent.id, projectId, addedById: adminId },
  });
  const bind = (agent: Agent, projectId: string | null = projects.p1, roleKey = 'viewer') => membership.createBinding(
    { principal: { type: 'AGENT', id: agent.id }, roleKey, projectId }, { type: 'USER', id: adminId },
  );
  const agent = async (slug: string, name = slug, roles: string[] = ['DEVELOPER']): Promise<Agent> => {
    const res = await request(server).post('/api/agents').set({ Authorization: `Bearer ${rootToken}` })
      .send({ slug, name, roles }).expect(201);
    const body = data<{ agent: { id: string; slug: string }; apiKey: string }>(res);
    return { ...body.agent, apiKey: body.apiKey };
  };
  const refusal = (res: request.Response, status: number, message: string) => {
    expect(res.status).toBe(status);
    expect(res.body.ret).not.toBe(0);
    expect(res.body).not.toHaveProperty('data');
    expect(res.body.message).toBe(message);
  };

  beforeAll(async () => {
    await resetDb();
    const previous = process.env.AGENT_PROJECT_SCOPING;
    process.env.AGENT_PROJECT_SCOPING = 'on';
    try { app = await bootHttpApp({ registrationEnabled: false }); }
    finally {
      if (previous === undefined) delete process.env.AGENT_PROJECT_SCOPING;
      else process.env.AGENT_PROJECT_SCOPING = previous;
    }
    server = app.getHttpServer();
    db = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    membership = app.get(MembershipService);
    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@roster.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    rootToken = data<{ accessToken: string }>(root).accessToken;
    const created = await request(server).post('/api/admin/users').set({ Authorization: `Bearer ${rootToken}` })
      .send({ email: 'admin@roster.test', name: 'Roster Admin', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    adminId = data<{ id: string }>(created).id;
    resetThrottle(app);
    adminToken = await loginToken(server, 'admin@roster.test');
    for (const [i, slug] of ['p1', 'p-alpha', 'p-beta'].entries()) {
      const p = await db.project.create({ data: { slug, name: slug, key: ['RP', 'RA', 'RB'][i] } });
      projects[slug] = p.id;
      await membership.createBinding({ principal: { type: 'USER', id: adminId }, roleKey: 'project-admin', projectId: p.id },
        { type: 'SYSTEM', id: 'test' });
    }
  }, 120_000);
  beforeEach(() => resetThrottle(app));
  afterAll(async () => { await app?.close(); });

  it('AC-1: POST grants viewer with caller provenance, not a legacy row', async () => {
    const a = await agent('add-bot');
    const res = await add(a);
    expect(res.status).toBe(201);
    expect(data<{ slug: string }>(res).slug).toBe(a.slug);
    expect(await bindings(a)).toMatchObject([{ role: { key: 'viewer' }, grantedByType: 'USER', grantedById: adminId }]);
    expect(await db.agentProject.count({ where: { agentId: a.id, projectId: projects.p1 } })).toBe(0);
  });
  it('AC-2: GET preserves adding caller id and name', async () => {
    const a = await agent('provenance-bot');
    await add(a).expect(201);
    expect(await bindings(a)).toMatchObject([{ role: { key: 'viewer' } }]);
    const res = await request(server).get('/api/projects/p1/agents').set(auth()).expect(200);
    expect(data<{ items: { slug: string; addedBy: unknown }[] }>(res).items.find(row => row.slug === a.slug)?.addedBy)
      .toEqual({ id: adminId, name: 'Roster Admin' });
  });
  it('AC-3: duplicate binding add is a conflict', async () => {
    const a = await agent('duplicate-bot');
    await add(a).expect(201);
    expect(await bindings(a)).toMatchObject([{ role: { key: 'viewer' } }]);
    refusal(await add(a), 409, 'Agent is already on the project roster');
  });
  it('AC-4: duplicate legacy add is a conflict', async () => {
    const a = await agent('legacy-duplicate-bot');
    await legacy(a);
    refusal(await add(a), 409, 'Agent is already on the project roster');
  });
  it('AC-5: list merges local sources in name order but excludes global-only agents', async () => {
    const a = await agent('list-bound-bot', 'AAA Bound');
    const b = await agent('list-legacy-bot', 'AAB Legacy');
    const g = await agent('list-global-bot', 'AAC Global');
    await add(a).expect(201);
    expect(await bindings(a)).toMatchObject([{ role: { key: 'viewer' } }]);
    await legacy(b);
    await bind(g, null, 'developer');
    const res = await request(server).get('/api/projects/p1/agents').set(auth()).expect(200);
    const rows = data<{ items: { slug: string; name: string }[] }>(res).items;
    expect(rows.map(row => row.slug)).toEqual(expect.arrayContaining([a.slug, b.slug]));
    expect(rows.map(row => row.slug)).not.toContain(g.slug);
    expect(rows.map(row => row.name)).toEqual(rows.map(row => row.name).sort());
  });
  it('AC-6: DELETE removes binding and revokes scoped ticket access', async () => {
    const a = await agent('remove-bound-bot');
    await add(a).expect(201);
    expect(await bindings(a)).toMatchObject([{ role: { key: 'viewer' } }]);
    await remove(a).expect(204);
    expect(await bindings(a)).toEqual([]);
    await request(server).get('/api/projects/p1/tickets').set({ Authorization: `Bearer ${a.apiKey}` }).expect(403);
  });
  it('AC-7: DELETE removes both local sources but keeps global grants', async () => {
    const a = await agent('remove-both-bot');
    await legacy(a);
    await bind(a);
    const global = await bind(a, null, 'developer');
    await remove(a).expect(204);
    expect(await bindings(a)).toEqual([]);
    expect(await db.agentProject.count({ where: { agentId: a.id, projectId: projects.p1 } })).toBe(0);
    expect(await db.roleBinding.findUnique({ where: { id: global.id } })).not.toBeNull();
  });
  it('AC-8: open tickets refuse DELETE and retain viewer', async () => {
    const a = await agent('open-ticket-bot');
    await add(a).expect(201);
    expect(await bindings(a)).toMatchObject([{ role: { key: 'viewer' } }]);
    await db.ticket.create({ data: { projectId: projects.p1, number: 1, title: 'Held', type: 'BUG',
      status: 'IN_PROGRESS', assignedToAgentId: a.id, createdByUserId: adminId } });
    const res = await remove(a);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('1 open tickets are still assigned to this agent: RP-1');
    expect(await bindings(a)).toMatchObject([{ role: { key: 'viewer' } }]);
  });
  it('AC-9: no local source is 404 even with global project access', async () => {
    const a = await agent('global-remove-bot');
    await bind(a, null, 'developer');
    refusal(await remove(a), 404, 'Project agent not found');
  });
  it('global-only access supports pickup, PATCH and me without local roster membership', async () => {
    const a = await agent('global-access-bot');
    await bind(a, null, 'developer');
    await request(server).get(`/api/agents/${a.slug}/pickup?project=p1`)
      .set({ Authorization: `Bearer ${a.apiKey}` }).expect(200);
    // US-001: updating an agent needs the global `agent.update` key, so the caller is the
    // installation Owner; the project admin of p1 is refused since the fold. The 200 (not a 404)
    // is still what shows the agent's global-only access reaches the project.
    await request(server).patch(`/api/projects/p1/agents/${a.slug}`)
      .set({ Authorization: `Bearer ${rootToken}` })
      .send({ name: 'Global renamed' }).expect(200);
    const me = await request(server).get('/api/agents/me')
      .set({ Authorization: `Bearer ${a.apiKey}` }).expect(200);
    expect(data<{ projects: { slug: string }[] }>(me).projects.map(p => p.slug).sort()).toEqual(['p-alpha', 'p-beta', 'p1']);
    refusal(await remove(a), 404, 'Project agent not found');
    await add(a).expect(201);
    expect(await bindings(a)).toMatchObject([{ role: { key: 'viewer' } }]);
  });
  it('earliest local source determines provenance, and a SYSTEM granter is not a user', async () => {
    const a = await agent('earliest-bot');
    await legacy(a);
    const first = new Date('2020-01-01T00:00:00.000Z');
    await db.agentProject.update({ where: { agentId_projectId: { agentId: a.id, projectId: projects.p1 } },
      data: { createdAt: first } });
    await membership.createBinding({ principal: { type: 'AGENT', id: a.id }, roleKey: 'viewer', projectId: projects.p1 },
      { type: 'SYSTEM', id: adminId });
    const b = await agent('system-granter-bot');
    await membership.createBinding({ principal: { type: 'AGENT', id: b.id }, roleKey: 'viewer', projectId: projects.p1 },
      { type: 'SYSTEM', id: adminId });
    const res = await request(server).get('/api/projects/p1/agents').set(auth()).expect(200);
    const rows = data<{ items: { slug: string; addedAt: string; addedBy: unknown }[] }>(res).items;
    expect(rows.find(row => row.slug === a.slug)).toMatchObject({ addedAt: first.toISOString(),
      addedBy: { id: adminId, name: 'Roster Admin' } });
    expect(rows.find(row => row.slug === b.slug)?.addedBy).toBeNull();
  });
  it('AC-10: explicitly bound developer agent can pick up from project', async () => {
    const a = await agent('pickup-bound-bot');
    await bind(a);
    await grantRole(db, { type: 'AGENT', id: a.id }, 'developer', projects.p1);
    await membership.invalidatePermissions();
    await request(server).get(`/api/agents/${a.slug}/pickup?project=p1`).set({ Authorization: `Bearer ${a.apiKey}` }).expect(200);
  });
  it('AC-11: agent without access cannot pick up from project', async () => {
    const a = await agent('pickup-none-bot');
    await request(server).get(`/api/agents/${a.slug}/pickup?project=p1`).set({ Authorization: `Bearer ${a.apiKey}` }).expect(403);
  });
  // Permissions P1 US-003: the pickup's own write (`writeAgentAction` of TICKET_SUGGESTED) is
  // authorized by the same `project.read` key as the route. The legacy actor-role allow-list omitted
  // VERIFIER, so a VERIFIER-only agent's pickup was refused *after* the pickup itself was allowed.
  it('US-003 AC-11: a rostered VERIFIER-only agent picks up and its TICKET_SUGGESTED event is stored', async () => {
    const a = await agent('pickup-verifier-bot', 'Pickup Verifier', ['VERIFIER']);
    await bind(a);
    await bind(a, projects.p1, 'verifier');
    const ticket = await db.ticket.create({
      data: {
        projectId: projects.p1, number: 900, title: 'Verifier pickup', type: 'BUG',
        status: 'VERIFIED', createdByUserId: adminId,
      },
    });
    // Recompute keys after the fixture writes.
    await membership.invalidatePermissions();

    const res = await request(server).get(`/api/agents/${a.slug}/pickup?project=p1`)
      .set({ Authorization: `Bearer ${a.apiKey}` }).expect(200);
    expect(data<{ ticket: { id: string; ref: string } }>(res).ticket.id).toBe(ticket.id);

    const events = await db.agentEvent.findMany({ where: { projectId: projects.p1, agentId: a.id } });
    expect(events.map((event) => event.action)).toContain('TICKET_SUGGESTED');
  });
  it('AC-12: me lists legacy and bound projects in slug order', async () => {
    const a = await agent('me-bot');
    await bind(a, projects['p-beta']);
    await legacy(a, projects['p-alpha']);
    const res = await request(server).get('/api/agents/me').set({ Authorization: `Bearer ${a.apiKey}` }).expect(200);
    expect(data<{ projects: { slug: string }[] }>(res).projects.map(p => p.slug)).toEqual(['p-alpha', 'p-beta']);
  });
  it('AC-13: concurrent adds produce one 201, one 409, and exactly one binding', async () => {
    const a = await agent('race-bot');
    const results = await Promise.all([add(a), add(a)]);
    expect(results.map(res => res.status).sort()).toEqual([201, 409]);
    expect(results.find(res => res.status === 409)?.body.message).toBe('Agent is already on the project roster');
    expect(await bindings(a)).toHaveLength(1);
  });
});

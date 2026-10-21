/**
 * Permissions P1b US-002 — project access, project lists and home read bindings (AC-1 .. AC-14), over
 * real HTTP on Postgres.
 *
 * Every principal here has exactly one kind of source in the project under test, so an AC passes only
 * when the reader consults the access sources: `PrismaProjectRepository.findMembershipRole` /
 * `isAgentOnRoster` / `findAllForUser` / `findAllForAgent` and `PrismaHomeRepository.findProjects` on
 * one side, and the `ProjectAccessService`, `ProjectsService` and members-list callers on the other.
 * Sources are real rows — bindings through `MembershipService.createBinding` (booting `AppModule` runs
 * `SystemRoleSeeder`, so the seeded keys exist), legacy rows through Prisma, which is what a
 * pre-bindings installation looks like.
 *
 * `agent project scoping` is a boot-time config flag, so AC-12 (scoping off) boots its own app, as
 * `bootstrap-baselines.integration.spec.ts` does for `KODA_OWNER_EMAIL`.
 *
 * Run: cd apps/api && bun run test:db:up &&
 *      bun run test:scoped test/integration/permissions/membership-project-access.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { InternalAppException } from '@nathapp/nestjs-common';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { MEMBERSHIP_READ_CAP, readAccessibleProjectIds } from '../../../src/permissions/legacy-membership.queries';
import { MembershipService } from '../../../src/permissions/membership.service';
import type { PrincipalRef } from '../../../src/permissions/permissions.types';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

/** Booting `AppModule` runs the system-role seeder, so the first hook needs a generous budget. */
const BOOT_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 30_000;

type HttpMethod = 'get' | 'post' | 'patch' | 'delete';

/** The project slugs every AC in this file uses; `gone` is soft-deleted before the tests run. */
const PROJECT_SLUGS = ['p1', 'p2', 'p3'] as const;
const LIVE_SLUGS = ['p1', 'p2', 'p3'];

interface AgentKey {
  id: string;
  slug: string;
  apiKey: string;
}

describeIntegration('project access and project lists read bindings (US-002, PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let membership: MembershipService;

  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const projectIds: Record<string, string> = {};
  const agents: Record<string, AgentKey> = {};
  let rootId = '';

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const agentAuth = (who: string) => ({ Authorization: `Bearer ${agents[who].apiKey}` });

  const send = (
    method: HttpMethod,
    url: string,
    who: string,
    body?: Record<string, unknown>,
  ): request.Test => {
    const req = request(server)[method](url).set(auth(who));
    return body === undefined ? req : req.send(body);
  };

  const userPrincipal = (who: string): PrincipalRef => ({ type: 'USER', id: ids[who] });
  const agentPrincipal = (who: string): PrincipalRef => ({ type: 'AGENT', id: agents[who].id });

  const bind = (principal: PrincipalRef, roleKey: string, projectId: string | null): Promise<unknown> =>
    membership.createBinding({ principal, roleKey, projectId }, { type: 'USER', id: rootId });

  /** A MEMBER-role user with a working token; registration is closed, so it goes through the admin route. */
  const createUser = async (who: string): Promise<void> => {
    resetThrottle(app);
    const created = await request(server).post('/api/admin/users').set(auth('root'))
      .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER' })
      .expect(201);
    ids[who] = data<{ id: string }>(created).id;
    resetThrottle(app);
    tokens[who] = await loginToken(server, `${who}@koda.test`);
  };

  const createAgent = async (name: string, slug: string): Promise<void> => {
    resetThrottle(app);
    const created = await request(server).post('/api/agents').set(auth('root'))
      .send({ name, slug, roles: ['DEVELOPER'] })
      .expect(201);
    const payload = data<{ apiKey: string; agent: { id: string; slug: string } }>(created);
    agents[name] = { id: payload.agent.id, slug: payload.agent.slug, apiKey: payload.apiKey };
  };

  const projectSlugs = (res: request.Response): string[] =>
    data<{ slug: string }[]>(res).map((project) => project.slug);

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    membership = app.get(MembershipService);

    // The bootstrap registration: the first user is the installation Owner, so it is a global ADMIN.
    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;
    rootId = (await prisma.user.findUniqueOrThrow({ where: { email: 'root@koda.test' } })).id;

    // Keys are 2-6 uppercase letters (`Koda` key regex), so they cannot carry the loop index.
    const projectKeys = ['KAA', 'KAB', 'KAC', 'KAD'];
    for (const [index, slug] of [...PROJECT_SLUGS, 'gone'].entries()) {
      await request(server).post('/api/projects').set(auth('root'))
        .send({ name: `Project ${slug}`, slug, key: projectKeys[index] }).expect(201);
    }
    for (const slug of [...PROJECT_SLUGS, 'gone']) {
      projectIds[slug] = (await prisma.project.findUniqueOrThrow({ where: { slug } })).id;
    }
    // A soft-deleted project never reaches a list, whatever sources point at it.
    await request(server).delete('/api/projects/gone').set(auth('root')).expect(204);

    for (const who of ['devBind', 'viewerBind', 'legDev', 'noSource', 'globalRev', 'paBound', 'listUser', 'customReader']) {
      await createUser(who);
    }
    const agentFixtures: Array<[string, string]> = [
      ['agViewer', 'acme-viewer'],
      ['agNone', 'acme-none'],
      ['agGlobal', 'acme-global'],
      ['agRoster', 'acme-roster'],
    ];
    for (const [name, slug] of agentFixtures) await createAgent(name, slug);

    await Promise.all([
      bind(userPrincipal('devBind'), 'developer', projectIds.p1),
      bind(userPrincipal('viewerBind'), 'viewer', projectIds.p1),
      bind(userPrincipal('globalRev'), 'reviewer', null),
      bind(userPrincipal('paBound'), 'project-admin', projectIds.p1),
      bind(userPrincipal('listUser'), 'developer', projectIds.p1),
      bind(agentPrincipal('agViewer'), 'viewer', projectIds.p1),
      bind(agentPrincipal('agGlobal'), 'developer', null),
    ]);

    // US-001 AC-11: a custom PROJECT role holding `ticket.read` and nothing else. It is created through
    // the role route (the seeder owns the system roles) so the installation's own role machinery writes
    // it, and the binding is the principal's only source in p1.
    resetThrottle(app);
    await request(server).post('/api/roles').set(auth('root'))
      .send({ key: 'ticket-reader', name: 'Ticket Reader', scope: 'PROJECT', permissions: ['ticket.read'] })
      .expect(201);
    await bind(userPrincipal('customReader'), 'ticket-reader', projectIds.p1);

    // The legacy rows: a ProjectMember row for legDev (US-002 AC-5) and for listUser in p2 (AC-10),
    // plus the AgentProject row AC-14's PATCH target needs.
    await prisma.projectMember.createMany({
      data: [
        { projectId: projectIds.p1, userId: ids.legDev, role: 'DEVELOPER' },
        { projectId: projectIds.p2, userId: ids.listUser, role: 'DEVELOPER' },
      ],
    });
    await prisma.agentProject.create({
      data: { projectId: projectIds.p1, agentId: agents.agRoster.id, addedById: rootId },
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it('AC-1: a developer binding is enough to read the project tickets', async () => {
    expect(await prisma.projectMember.count({ where: { projectId: projectIds.p1, userId: ids.devBind } })).toBe(0);

    const res = await send('get', '/api/projects/p1/tickets', 'devBind');

    expect(res.status).toBe(200);
  }, TEST_TIMEOUT_MS);

  it('AC-2: the same developer binding carries the project DEVELOPER role into ticket create', async () => {
    const res = await send('post', '/api/projects/p1/tickets', 'devBind', {
      type: 'BUG',
      title: 'Created through a developer binding',
    });

    expect(res.status).toBe(201);
    expect(data<{ createdByUserId: string }>(res).createdByUserId).toBe(ids.devBind);
  }, TEST_TIMEOUT_MS);

  it('AC-3: a viewer binding is not enough to create a ticket', async () => {
    const res = await send('post', '/api/projects/p1/tickets', 'viewerBind', {
      type: 'BUG',
      title: 'Never created',
    });

    expect(res.status).toBe(403);
  }, TEST_TIMEOUT_MS);

  it('AC-4: a non-admin user with no source in the project gets 403', async () => {
    const res = await send('get', '/api/projects/p1/tickets', 'noSource');

    expect(res.status).toBe(403);
  }, TEST_TIMEOUT_MS);

  it('AC-5: a legacy ProjectMember DEVELOPER row keeps its access', async () => {
    const res = await send('get', '/api/projects/p1/tickets', 'legDev');

    expect(res.status).toBe(200);
  }, TEST_TIMEOUT_MS);

  it('AC-6: with scoping on, a viewer binding gives an agent project reach', async () => {
    const res = await request(server).get('/api/projects/p1/tickets').set(agentAuth('agViewer'));

    expect(res.status).toBe(200);
  }, TEST_TIMEOUT_MS);

  it('AC-7: with scoping on, an agent with no source in the project gets 403', async () => {
    const res = await request(server).get('/api/projects/p1/tickets').set(agentAuth('agNone'));

    expect(res.status).toBe(403);
  }, TEST_TIMEOUT_MS);

  it('AC-8: a projectId-null reviewer binding reaches the project', async () => {
    expect(await prisma.projectMember.count({ where: { projectId: projectIds.p1, userId: ids.globalRev } })).toBe(0);

    const res = await send('get', '/api/projects/p1/tickets', 'globalRev');

    expect(res.status).toBe(200);
  }, TEST_TIMEOUT_MS);

  it('AC-9: a project-admin binding makes its holder a project admin on the members route', async () => {
    const res = await send('get', '/api/projects/p1/members', 'paBound');

    expect(res.status).toBe(200);
    const body = data<{ canManage: boolean; viewerRole: string }>(res);
    expect(body.canManage).toBe(true);
    expect(body.viewerRole).toBe('ADMIN');
  }, TEST_TIMEOUT_MS);

  it('AC-10: GET /projects lists exactly the projects a user has a source in', async () => {
    const res = await send('get', '/api/projects', 'listUser');

    expect(res.status).toBe(200);
    // p1 through a developer binding, p2 through a legacy row, and not the bound-less p3.
    expect(projectSlugs(res).sort()).toEqual(['p1', 'p2']);
    expect(projectSlugs(res)).not.toContain('p3');
  }, TEST_TIMEOUT_MS);

  it('AC-11: with scoping on, a projectId-null developer binding lists every non-deleted project', async () => {
    const res = await request(server).get('/api/projects').set(agentAuth('agGlobal'));

    expect(res.status).toBe(200);
    expect(projectSlugs(res).sort()).toEqual(LIVE_SLUGS);
  }, TEST_TIMEOUT_MS);

  it('AC-13: GET /home includes a project the caller only has a binding in', async () => {
    const res = await send('get', '/api/home', 'devBind');

    expect(res.status).toBe(200);
    const slugs = data<{ projects: { slug: string }[] }>(res).projects.map((project) => project.slug);
    expect(slugs).toContain('p1');
    // The binding is the only source, so nothing else is in scope for this caller.
    expect(slugs).toEqual(['p1']);
  }, TEST_TIMEOUT_MS);

  it('AC-14: a global admin may update an agent that is on the legacy roster', async () => {
    // US-001: the project-scoped `project.agent.update` is folded into the global `agent.update`, so
    // the caller that may update an agent is a global admin; the legacy roster row is still what
    // makes the agent reachable in the project (without it the route answers 404).
    const res = await send('patch', `/api/projects/p1/agents/${agents.agRoster.slug}`, 'root', {
      name: 'Renamed Bot',
    });

    expect(res.status).toBe(200);
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agents.agRoster.id } });
    expect(agent.name).toBe('Renamed Bot');
  }, TEST_TIMEOUT_MS);

  // ---------------------------------------------------------------------------
  // US-001 — access to a project is holding `project.read` in it, while the members page keeps
  // showing the caller's display role (`viewerRole`).
  // ---------------------------------------------------------------------------

  it('US-001 AC-11: a custom PROJECT role without project.read gets 403 projects from the guard', async () => {
    // The custom role grants `ticket.read` and nothing else, so the route's own key would pass: a 403
    // answered with the projects prefix can only come from ProjectMembershipGuard, before RequiresGuard.
    expect(await prisma.projectMember.count({ where: { projectId: projectIds.p1, userId: ids.customReader } })).toBe(0);
    expect(await prisma.roleBinding.count({ where: { projectId: projectIds.p1, principalId: ids.customReader } })).toBe(1);

    const res = await send('get', '/api/projects/p1/tickets', 'customReader');

    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe('projects.40003');
  }, TEST_TIMEOUT_MS);

  it('US-001 AC-12: a global admin with no source in p1 gets viewerRole ADMIN', async () => {
    expect(await prisma.projectMember.count({ where: { projectId: projectIds.p1, userId: rootId } })).toBe(0);
    expect(await prisma.roleBinding.count({ where: { projectId: projectIds.p1, principalId: rootId } })).toBe(0);

    const res = await send('get', '/api/projects/p1/members', 'root');

    expect(res.status).toBe(200);
    expect(data<{ viewerRole: string }>(res).viewerRole).toBe('ADMIN');
  }, TEST_TIMEOUT_MS);

  it('US-001 AC-13: a viewer binding gets viewerRole VIEWER', async () => {
    expect(await prisma.projectMember.count({ where: { projectId: projectIds.p1, userId: ids.viewerBind } })).toBe(0);

    const res = await send('get', '/api/projects/p1/members', 'viewerBind');

    expect(res.status).toBe(200);
    expect(data<{ canManage: boolean; viewerRole: string }>(res)).toEqual(
      expect.objectContaining({ canManage: false, viewerRole: 'VIEWER' }),
    );
  }, TEST_TIMEOUT_MS);
});

/**
 * AC-12 needs `AGENT_PROJECT_SCOPING=off`, which is read once at `AppFactory.create`: its own app and
 * its own world, reset and re-seeded by this describe.
 */
describeIntegration('project lists with agent project scoping off (US-002 AC-12, PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let agentKey = '';
  let accessToken = '';

  beforeAll(async () => {
    await resetDb();
    // `AGENT_PROJECT_SCOPING` is read once, at `AppFactory.create`.
    const previousScoping = process.env.AGENT_PROJECT_SCOPING;
    process.env.AGENT_PROJECT_SCOPING = 'off';
    try {
      app = await bootHttpApp({ registrationEnabled: false });
    } finally {
      if (previousScoping === undefined) delete process.env.AGENT_PROJECT_SCOPING;
      else process.env.AGENT_PROJECT_SCOPING = previousScoping;
    }
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;

    const root = await request(server).post('/api/auth/register')
      .send({ email: 'scoping-root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    accessToken = data<{ accessToken: string }>(root).accessToken;

    for (const [index, slug] of (['p1', 'p2'] as const).entries()) {
      await request(server).post('/api/projects').set({ Authorization: `Bearer ${accessToken}` })
        .send({ name: `Project ${slug}`, slug, key: ['SA', 'SB'][index] }).expect(201);
    }

    const created = await request(server).post('/api/agents').set({ Authorization: `Bearer ${accessToken}` })
      .send({ name: 'Unscoped Agent', slug: 'unscoped-agent', roles: ['DEVELOPER'] }).expect(201);
    agentKey = data<{ apiKey: string }>(created).apiKey;
    // No AgentProject row, no binding: the agent has no membership source at all.
    expect(await prisma.agentProject.count()).toBe(0);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it('AC-12: with scoping off, an unscoped agent lists every non-deleted project', async () => {
    const res = await request(server).get('/api/projects').set({ Authorization: `Bearer ${agentKey}` });

    expect(res.status).toBe(200);
    expect(data<{ slug: string }[]>(res).map((project) => project.slug).sort()).toEqual(['p1', 'p2']);
  }, TEST_TIMEOUT_MS);
});

/**
 * US-002 AC-11 past the compatibility queries' read cap: a `projectId`-null PROJECT binding means
 * **every** non-deleted project, so neither `accessibleProjectIds` nor the project and home lists
 * built on it may stop at `MEMBERSHIP_READ_CAP` rows. Its own world, because the projects past the
 * cap are live and would be part of every other describe's list.
 */
describeIntegration('project lists past the membership read cap (US-002 AC-11, PG)', () => {
  /** Five past the cap, so the truncated answer differs from the complete one. */
  const TOTAL = MEMBERSHIP_READ_CAP + 5;
  /** 2-6 uppercase letters, unique for every index below 26^3 (the `CreateProjectDto` key shape). */
  const bulkKey = (index: number): string => {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    return `${letters[Math.floor(index / 676) % 26]}${letters[Math.floor(index / 26) % 26]}${letters[index % 26]}`;
  };

  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let agentKey = '';
  let slugs: string[] = [];

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    const membership = app.get(MembershipService);

    const root = await request(server).post('/api/auth/register')
      .send({ email: 'cap-root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    const accessToken = data<{ accessToken: string }>(root).accessToken;
    const rootId = (await prisma.user.findUniqueOrThrow({ where: { email: 'cap-root@koda.test' } })).id;

    // Inserted through Prisma: 5005 projects over the create route would be 5005 HTTP calls.
    slugs = Array.from({ length: TOTAL }, (_, index) => `cap-${String(index).padStart(4, '0')}`);
    await prisma.project.createMany({
      data: slugs.map((slug, index) => ({ name: `Cap ${String(index).padStart(4, '0')}`, slug, key: bulkKey(index) })),
    });

    const created = await request(server).post('/api/agents').set({ Authorization: `Bearer ${accessToken}` })
      .send({ name: 'Cap Agent', slug: 'cap-agent', roles: ['DEVELOPER'] }).expect(201);
    const agent = data<{ apiKey: string; agent: { id: string } }>(created);
    agentKey = agent.apiKey;
    // The only source: a projectId-null PROJECT binding, which applies in every project.
    await membership.createBinding(
      { principal: { type: 'AGENT', id: agent.agent.id }, roleKey: 'developer', projectId: null },
      { type: 'USER', id: rootId },
    );
    expect(await prisma.agentProject.count()).toBe(0);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
  });

  it('AC-11: GET /projects lists all 5005 live projects, not the first read-cap page', async () => {
    const res = await request(server).get('/api/projects').set({ Authorization: `Bearer ${agentKey}` });

    expect(res.status).toBe(200);
    const listed = data<{ slug: string }[]>(res).map((project) => project.slug);
    expect(listed).toHaveLength(TOTAL);
    expect([...listed].sort()).toEqual([...slugs].sort());
  }, 120_000);

  it('AC-11: the paging read finishes on a short page, and fails loudly if its bound stops it first', async () => {
    // The production bound (10,000 pages) cannot be reached with real rows, so the read is driven with
    // small ones: 5005 projects is one full page plus a short one.
    const projectIds = await readAccessibleProjectIds(prisma, undefined, 'USER:cap', 2);
    expect(projectIds).toHaveLength(TOTAL);

    await expect(readAccessibleProjectIds(prisma, undefined, 'USER:cap', 1)).rejects.toBeInstanceOf(
      InternalAppException,
    );
  }, 120_000);
});

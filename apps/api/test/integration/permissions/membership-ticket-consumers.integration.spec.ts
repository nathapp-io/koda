/**
 * Permissions P1b US-003 — ticket assignment, assignee search and the domain writer read the
 * compatibility union (AC-1 .. AC-10), over real HTTP and real Postgres.
 *
 * Every principal here has exactly one kind of source in the project under test, so an AC passes only
 * when the reader consults the access sources: `PrismaTicketsRepository.isAgentOnProjectRoster` /
 * the assignee's `project.read`, `PrismaProjectAssigneesRepository.search` and `KodaDomainWriter` (which
 * decides on `project.read`) on one side, and `TicketsService.assign`, `ProjectAssigneesService.search`
 * and `KodaDomainWriter.writeTicketEvent` on the other. Sources are
 * real rows — bindings through `MembershipService.createBinding` (booting the app runs
 * `SystemRoleSeeder`, so the seeded role keys exist), the legacy `ProjectMember` row through Prisma,
 * which is what a pre-bindings installation looks like.
 *
 * The assigning and searching caller is the installation's global admin, whose own membership never
 * comes from a binding: that isolates each AC on the *assignee's* sources.
 *
 * Run: cd apps/api && bun run test:db:up &&
 *      bun run test:scoped test/integration/permissions/membership-ticket-consumers.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { KodaDomainWriter } from '../../../src/koda-domain-writer/koda-domain-writer.service';
import { MembershipService } from '../../../src/permissions/membership.service';
import type { PrincipalRef } from '../../../src/permissions/permissions.types';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

/** Booting `AppModule` runs the system-role seeder, so the first hook needs a generous budget. */
const BOOT_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 30_000;

/** 2-6 uppercase letters (`CreateProjectDto` key regex). */
const PROJECT_SLUG = 'p1';
const PROJECT_KEY = 'KTA';

/** The English sentence of `tickets.agentNotInProject` at HTTP 409, read from the catalog. */
const AGENT_NOT_IN_PROJECT = (
  JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en/tickets.json'), 'utf8')) as {
    agentNotInProject: Record<string, string>;
  }
).agentNotInProject['409'];

interface AssigneeItem {
  type: 'user' | 'agent';
  id: string;
}

describeIntegration('ticket consumers read bindings (US-003, PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let membership: MembershipService;
  let writer: KodaDomainWriter;

  let rootToken = '';
  let rootId = '';
  let projectId = '';
  const ids: Record<string, string> = {};
  const agentIds: Record<string, string> = {};

  const auth = () => ({ Authorization: `Bearer ${rootToken}` });

  const userPrincipal = (who: string): PrincipalRef => ({ type: 'USER', id: ids[who] });
  const bind = (principal: PrincipalRef, roleKey: string, projectIdOrNull: string | null) =>
    membership.createBinding({ principal, roleKey, projectId: projectIdOrNull }, { type: 'USER', id: rootId });

  /** A MEMBER-role user with a working account; registration is closed, so it goes through the admin route. */
  const createUser = async (who: string, options: { disabled?: boolean } = {}): Promise<string> => {
    resetThrottle(app);
    const created = await request(server).post('/api/admin/users').set(auth())
      .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER' })
      .expect(201);
    const id = data<{ id: string }>(created).id;
    if (options.disabled) {
      await request(server).patch(`/api/admin/users/${id}`).set(auth()).send({ disabled: true }).expect(200);
    }
    return id;
  };

  const createAgent = async (name: string, slug: string): Promise<string> => {
    resetThrottle(app);
    const created = await request(server).post('/api/agents').set(auth())
      .send({ name, slug, roles: ['DEVELOPER'] })
      .expect(201);
    const payload = data<{ agent: { id: string; status: string } }>(created);
    expect(payload.agent.status).toBe('ACTIVE');
    agentIds[name] = payload.agent.id;
    return payload.agent.id;
  };

  const createTicket = async (title: string): Promise<{ id: string; ref: string }> => {
    resetThrottle(app);
    const created = await request(server).post(`/api/projects/${PROJECT_SLUG}/tickets`).set(auth())
      .send({ type: 'BUG', title })
      .expect(201);
    return data<{ id: string; ref: string }>(created);
  };

  const assignTicket = (ref: string, body: Record<string, unknown>): request.Test =>
    request(server).post(`/api/projects/${PROJECT_SLUG}/tickets/${ref}/assign`).set(auth()).send(body);

  const assignees = async (): Promise<AssigneeItem[]> => {
    const res = await request(server)
      .get(`/api/projects/${PROJECT_SLUG}/assignees?limit=50`)
      .set(auth())
      .expect(200);
    return data<{ items: AssigneeItem[] }>(res).items;
  };

  /** Assertion-friendly `type:id` keys of the offered assignees. */
  const offeredKeys = async (): Promise<string[]> =>
    (await assignees()).map((item) => `${item.type}:${item.id}`);

  /**
   * The principal's **access sources from bindings**, which is what every AC below claims to be the
   * only source: the PROJECT-scope bindings it holds, `projectId`-null ones included. A GLOBAL-scope
   * binding (`member`, `owner`, `admin`, `agent`) is never a source — the admin and agent create
   * routes write one as a baseline for every principal, and
   * `src/permissions/legacy-membership.queries.spec.ts` pins that it is no source ("a GLOBAL-scope
   * binding is never a source").
   */
  const projectBindingsOf = async (type: 'USER' | 'AGENT', id: string) =>
    prisma.roleBinding.findMany({
      where: { principalType: type, principalId: id, role: { scope: 'PROJECT' } },
      select: { projectId: true, role: { select: { key: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    const prismaService = app.get<PrismaService<PrismaClient>>(PrismaService);
    prisma = prismaService.client;
    membership = app.get(MembershipService);
    writer = app.get(KodaDomainWriter);

    // The bootstrap registration: the first user is the installation Owner, so it is a global ADMIN.
    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    rootToken = data<{ accessToken: string }>(root).accessToken;
    rootId = (await prisma.user.findUniqueOrThrow({ where: { email: 'root@koda.test' } })).id;

    await request(server).post('/api/projects').set(auth())
      .send({ name: 'Project p1', slug: PROJECT_SLUG, key: PROJECT_KEY }).expect(201);
    projectId = (await prisma.project.findUniqueOrThrow({ where: { slug: PROJECT_SLUG } })).id;

    for (const who of ['devBind', 'viewerBind', 'globalViewer', 'legacyMember', 'noSource']) {
      ids[who] = await createUser(who);
    }
    ids.disabledDev = await createUser('disabledDev', { disabled: true });

    await createAgent('agViewer', 'acme-viewer');
    await createAgent('agNone', 'acme-none');

    await Promise.all([
      bind(userPrincipal('devBind'), 'developer', projectId),
      bind(userPrincipal('viewerBind'), 'viewer', projectId),
      // A binding with no project applies in every project: the only source of globalViewer.
      bind(userPrincipal('globalViewer'), 'viewer', null),
      bind(userPrincipal('disabledDev'), 'developer', projectId),
    ]);

    // The legacy row: what a pre-bindings installation holds (AC-7). No binding of any kind.
    await prisma.projectMember.create({
      data: { projectId, userId: ids.legacyMember, role: 'DEVELOPER' },
    });

    // The viewer-bound agent (AC-3/AC-5): a binding is its only source — no roster row, no membership.
    await bind({ type: 'AGENT', id: agentIds.agViewer }, 'viewer', projectId);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it('AC-1: a developer binding is enough to assign the ticket to that user', async () => {
    expect(await prisma.projectMember.count({ where: { projectId, userId: ids.devBind } })).toBe(0);
    expect(await projectBindingsOf('USER', ids.devBind)).toEqual([
      { projectId, role: { key: 'developer' } },
    ]);
    const ticket = await createTicket('Assigned through a developer binding');

    const res = await assignTicket(ticket.ref, { userId: ids.devBind }).expect(200);

    expect(data<{ assignedToUserId: string }>(res).assignedToUserId).toBe(ids.devBind);
    const stored = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(stored.assignedToUserId).toBe(ids.devBind);
  }, TEST_TIMEOUT_MS);

  it('AC-2: an enabled user with no source in the project gets 403', async () => {
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.noSource } })).disabled).toBe(false);
    expect(await projectBindingsOf('USER', ids.noSource)).toEqual([]);
    expect(await prisma.projectMember.count({ where: { projectId, userId: ids.noSource } })).toBe(0);
    const ticket = await createTicket('Refused assignee');

    const res = await assignTicket(ticket.ref, { userId: ids.noSource });

    expect(res.status).toBe(403);
    const stored = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(stored.assignedToUserId).toBeNull();
  }, TEST_TIMEOUT_MS);

  it('AC-3: a viewer binding is enough to assign the ticket to that agent', async () => {
    expect(await prisma.agentProject.count({ where: { projectId, agentId: agentIds.agViewer } })).toBe(0);
    expect(await projectBindingsOf('AGENT', agentIds.agViewer)).toEqual([
      { projectId, role: { key: 'viewer' } },
    ]);
    const ticket = await createTicket('Assigned through a viewer binding');

    const res = await assignTicket(ticket.ref, { agentId: agentIds.agViewer }).expect(200);

    expect(data<{ assignedToAgentId: string }>(res).assignedToAgentId).toBe(agentIds.agViewer);
    const stored = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(stored.assignedToAgentId).toBe(agentIds.agViewer);
  }, TEST_TIMEOUT_MS);

  it('AC-4: an ACTIVE agent with no source in the project gets 409 tickets.agentNotInProject', async () => {
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentIds.agNone } })).status).toBe('ACTIVE');
    expect(await prisma.agentProject.count({ where: { projectId, agentId: agentIds.agNone } })).toBe(0);
    expect(await projectBindingsOf('AGENT', agentIds.agNone)).toEqual([]);
    const ticket = await createTicket('Refused agent assignee');

    const res = await assignTicket(ticket.ref, { agentId: agentIds.agNone });

    expect(res.status).toBe(409);
    expect((res.body as { ret: number; message: string }).ret).not.toBe(0);
    expect((res.body as { message: string }).message).toBe(AGENT_NOT_IN_PROJECT);
    const stored = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(stored.assignedToAgentId).toBeNull();
  }, TEST_TIMEOUT_MS);

  it('AC-5: the assignee list offers the developer-bound user and the viewer-bound agent', async () => {
    const offered = await offeredKeys();

    expect(offered).toContain(`user:${ids.devBind}`);
    expect(offered).toContain(`agent:${agentIds.agViewer}`);
  }, TEST_TIMEOUT_MS);

  it('AC-6: a projectId-null binding is offered, a disabled developer-bound user is not', async () => {
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.disabledDev } })).disabled).toBe(true);
    // Both users also hold the admin route's GLOBAL-scope `member` baseline, which is never a source:
    // the list below is their access sources from bindings.
    expect(await prisma.roleBinding.count({
      where: { principalType: 'USER', principalId: ids.disabledDev, role: { scope: 'GLOBAL' } },
    })).toBe(1);
    expect(await projectBindingsOf('USER', ids.globalViewer)).toEqual([
      { projectId: null, role: { key: 'viewer' } },
    ]);
    expect(await projectBindingsOf('USER', ids.disabledDev)).toEqual([
      { projectId, role: { key: 'developer' } },
    ]);

    const offered = await offeredKeys();

    expect(offered).toContain(`user:${ids.globalViewer}`);
    expect(offered).not.toContain(`user:${ids.disabledDev}`);
  }, TEST_TIMEOUT_MS);

  it('AC-7: a user whose only source is a legacy ProjectMember row is still offered', async () => {
    expect(await projectBindingsOf('USER', ids.legacyMember)).toEqual([]);
    expect(await prisma.projectMember.count({ where: { projectId, userId: ids.legacyMember } })).toBe(1);

    const offered = await offeredKeys();

    expect(offered).toContain(`user:${ids.legacyMember}`);
  }, TEST_TIMEOUT_MS);

  it('AC-8: the writer records the event for a user whose only source is a developer binding', async () => {
    expect(await prisma.projectMember.count({ where: { projectId, userId: ids.devBind } })).toBe(0);
    expect(await projectBindingsOf('USER', ids.devBind)).toEqual([
      { projectId, role: { key: 'developer' } },
    ]);
    const ticket = await createTicket('Written through a developer binding');

    const result = await writer.writeTicketEvent({
      ticketId: ticket.id,
      projectId,
      action: 'TICKET_CREATED',
      actorId: ids.devBind,
      actorType: 'user',
      source: 'api',
      data: {},
    });

    expect(result.canonicalId).toBeTruthy();
    expect(await prisma.ticketEvent.count({ where: { projectId, actorId: ids.devBind } })).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('AC-9: the writer records the event for a user whose only source is a viewer binding', async () => {
    expect(await prisma.projectMember.count({ where: { projectId, userId: ids.viewerBind } })).toBe(0);
    expect(await projectBindingsOf('USER', ids.viewerBind)).toEqual([
      { projectId, role: { key: 'viewer' } },
    ]);
    const ticket = await createTicket('Written through a viewer binding');

    // US-003: the writer decides on `project.read`, which the viewer role holds — this is the
    // behaviour the legacy ADMIN/DEVELOPER/REVIEWER/TRIAGER/AGENT allow-list got wrong.
    const result = await writer.writeTicketEvent({
      ticketId: ticket.id,
      projectId,
      action: 'TICKET_CREATED',
      actorId: ids.viewerBind,
      actorType: 'user',
      source: 'api',
      data: {},
    });

    expect(result.canonicalId).toBeTruthy();
    expect(await prisma.ticketEvent.count({ where: { projectId, actorId: ids.viewerBind } })).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('AC-10: the writer refuses a user with no source in the project and records no event', async () => {
    expect(await projectBindingsOf('USER', ids.noSource)).toEqual([]);
    expect(await prisma.projectMember.count({ where: { projectId, userId: ids.noSource } })).toBe(0);
    const ticket = await createTicket('Refused with no source in the project');

    // A USER with no source holds its GLOBAL `member` baseline and nothing project-scoped, so it has
    // no `project.read` here. The effective keys are cached per principal and project; nothing above
    // wrote a row for it, but invalidating keeps this independent of the order the cases run in.
    await membership.invalidatePermissions();

    await expect(
      writer.writeTicketEvent({
        ticketId: ticket.id,
        projectId,
        action: 'TICKET_CREATED',
        actorId: ids.noSource,
        actorType: 'user',
        source: 'api',
        data: {},
      }),
    ).rejects.toBeInstanceOf(ForbiddenAppException);

    expect(await prisma.ticketEvent.count({ where: { projectId, actorId: ids.noSource } })).toBe(0);
  }, TEST_TIMEOUT_MS);
});

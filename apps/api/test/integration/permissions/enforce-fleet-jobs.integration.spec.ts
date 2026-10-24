/**
 * Permissions P1d US-003 — the job routes and the ticket fleet-job routes check catalog keys, and a
 * RUN dispatch starts its linked tickets without asking the dispatcher for the ticket's edge key,
 * over real HTTP + Postgres (AC-1 .. AC-24).
 *
 * One booted application for the whole file. The first registration is the installation's Owner, so
 * the fixtures (users, project, tickets, agent bindings) are built as that Owner; every assertion
 * below acts as a principal whose only source in `p1` is one role binding (users) or a `viewer`
 * binding with (or without) a role binding (agents). No test asserts through a bypass.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/enforce-fleet-jobs.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { MembershipService } from '../../../src/permissions/membership.service';
import { PermissionService } from '../../../src/permissions/permission.service';
import { expectBindingOnlyFixtures, grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const P1_SLUG = 'p1';
const P1_KEY = 'PONE';
const TIMEOUT = 30_000;
const BOOT_TIMEOUT = 60_000;

const readI18n = (file: string): Record<string, string> =>
  JSON.parse(readFileSync(join(__dirname, `../../../src/i18n/en/${file}.json`), 'utf8')) as Record<string, string>;

/** `permissions.40003`, the sentence every refused key carries. */
const PERMISSIONS_REFUSED = readI18n('permissions')['40003'];

interface JobRow {
  id: string;
  state: string;
  requestedById: string;
  requestedByType: string;
}

/** The role key an agent's legacy `AgentRoleEntry` role is read as (the union's own mapping). */
const ROLE_KEY_FOR_AGENT_ROLE: Record<'DEVELOPER' | 'REVIEWER' | 'VERIFIER' | 'TRIAGER', string> = {
  DEVELOPER: 'developer',
  REVIEWER: 'reviewer',
  VERIFIER: 'verifier',
  TRIAGER: 'triager',
};

describeIntegration('fleet job and ticket fleet-job route keys (US-003)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let membership: MembershipService;
  let permissions: PermissionService;

  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};
  let p1Id = '';
  let repoId = '';
  let counter = 0;
  let rootId = '';
  let developerAgentId = '';
  let rosterAgentId = '';

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const asRoot = (method: 'get' | 'post' | 'patch' | 'delete', url: string, body?: Record<string, unknown>) => {
    const req = request(server)[method](url).set(auth('root'));
    return body === undefined ? req : req.send(body);
  };

  /** The refusal contract of one refused permission key: 403, code 40003, the exact sentence. */
  const expectPermissionsRefusal = (res: request.Response): void => {
    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(PERMISSIONS_REFUSED);
  };

  const createUser = async (who: string): Promise<void> => {
    const created = await asRoot('post', '/api/admin/users', {
      email: `${who}@koda.test`,
      name: who,
      password: TEST_PASSWORD,
      role: 'MEMBER',
    }).expect(201);
    userIds[who] = data<{ id: string }>(created).id;
    resetThrottle(app);
    tokens[who] = await loginToken(server, `${who}@koda.test`);
  };

  /** The binding that is the caller's only source in p1. */
  const bind = (who: string, roleKey: string): Promise<unknown> =>
    withTestActor({ type: 'SYSTEM', id: 'seed' }, () => membership.createBinding(
      { principal: { type: 'USER', id: userIds[who] }, roleKey, projectId: p1Id },
      { type: 'SYSTEM', id: 'test' },
    ));

  /** A rostered agent whose only key source is the `viewer` binding plus the role binding given. */
  const createAgent = async (slug: string, agentRole?: 'DEVELOPER'): Promise<string> => {
    const created = await asRoot('post', '/api/agents', { name: slug, slug }).expect(201);
    const body = data<{ apiKey: string; agent: { id: string } }>(created);
    const agent = { type: 'AGENT' as const, id: body.agent.id };
    await grantBaseline(db, agent);
    await grantRole(db, agent, 'viewer', p1Id);
    if (agentRole) await grantRole(db, agent, ROLE_KEY_FOR_AGENT_ROLE[agentRole], p1Id);
    tokens[slug] = body.apiKey;
    // The bindings are written after the principal could have been cached by an earlier check.
    await membership.invalidatePermissions();
    return body.agent.id;
  };

  const dispatchUrl = () => `/api/projects/${P1_SLUG}/fleet/jobs`;
  const dispatch = (who: string, body: Record<string, unknown> = {}) =>
    request(server)
      .post(dispatchUrl())
      .set(auth(who))
      .send({ repoId, command: 'RUN', maxCostUsd: 5, feature: `f-${(counter += 1)}`, ...body });

  const jobUrl = (id: string, action?: 'cancel' | 'requeue') =>
    `${dispatchUrl()}/${id}${action ? `/${action}` : ''}`;

  /** A job row as the fixtures leave it; the default requester is `other`. */
  const newJob = async (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}): Promise<JobRow> => {
    const row = await db.fleetJob.create({
      data: {
        projectId: p1Id, repoId, ref: 'trunk', command: 'RUN', feature: `job-${(counter += 1)}`, profiles: [],
        maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: userIds.other, state: 'QUEUED', ...over,
      },
    });
    return row as JobRow;
  };

  /** A ticket of p1 in the given status, numbered past any other fixture. */
  const newTicket = async (status = 'CREATED'): Promise<{ id: string; ref: string }> => {
    const number = (counter += 1);
    const row = await db.ticket.create({ data: { projectId: p1Id, number, type: 'TASK', title: `Ticket ${number}`, status } });
    return { id: row.id, ref: `${P1_KEY}-${number}` };
  };

  const jobCount = () => db.fleetJob.count({ where: { projectId: p1Id } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    server = app.getHttpServer();
    db = fixtureDb(app);
    membership = app.get(MembershipService);
    permissions = app.get(PermissionService);

    const root = await request(server)
      .post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD })
      .expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;
    rootId = (await db.user.findUniqueOrThrow({ where: { email: 'root@koda.test' } })).id;

    for (const who of ['viewer', 'developer', 'other', 'outsider', 'custom']) await createUser(who);

    const project = await asRoot('post', '/api/projects', { name: 'P1', slug: P1_SLUG, key: P1_KEY }).expect(201);
    p1Id = data<{ id: string }>(project).id;
    const repo = await db.fleetRepo.create({
      data: { projectId: p1Id, provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'trunk', createdById: rootId },
    });
    repoId = repo.id;

    await bind('viewer', 'viewer');
    await bind('developer', 'developer');
    // AC-15: a custom role that may dispatch and read but holds no ticket edge key. US-001:
    // `project.read` is what lets the caller reach the project at all.
    await db.role.create({
      data: {
        key: 'fleet-dispatcher',
        name: 'Fleet Dispatcher',
        scope: 'PROJECT',
        permissions: ['project.read', 'fleet.job.dispatch', 'fleet.job.read', 'ticket.read'],
      },
    });
    await bind('custom', 'fleet-dispatcher');

    developerAgentId = await createAgent('p1-developer-agent', 'DEVELOPER');
    rosterAgentId = await createAgent('p1-roster-agent');
  }, BOOT_TIMEOUT);

  afterAll(async () => {
    await app?.close();
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // The sentinel: every fixture principal of this file is granted through bindings only
  // -------------------------------------------------------------------------

  it('fixtures grant through bindings only', async () => {
    await expectBindingOnlyFixtures(db, [
      { type: 'USER', id: rootId },
      { type: 'USER', id: userIds.viewer },
      { type: 'USER', id: userIds.developer },
      { type: 'USER', id: userIds.other },
      { type: 'USER', id: userIds.outsider },
      { type: 'USER', id: userIds.custom },
      { type: 'AGENT', id: developerAgentId },
      { type: 'AGENT', id: rosterAgentId },
    ]);
  });

  // -------------------------------------------------------------------------
  // AC-24 (US-003 AC-2) — the developer's ticket.create key stays in the project it is bound in
  // -------------------------------------------------------------------------

  it('AC-24: the developer agent holds ticket.create in p1 through its binding and not in p2', async () => {
    const p2 = await asRoot('post', '/api/projects', { name: 'P2', slug: 'p2', key: 'PTWO' }).expect(201);
    const p2Id = data<{ id: string }>(p2).id;
    const agent = { type: 'AGENT' as const, id: developerAgentId };

    // The access comes from the project's bindings, not from a legacy roster row.
    const bindings = await db.roleBinding.findMany({
      where: { principalType: 'AGENT', principalId: developerAgentId, projectId: p1Id },
      select: { role: { select: { key: true } } },
    });
    expect(bindings.map((row) => row.role.key).sort()).toEqual(['developer', 'viewer']);

    expect((await permissions.effectiveKeys(agent, { projectId: p1Id })).has('ticket.create')).toBe(true);
    expect((await permissions.effectiveKeys(agent, { projectId: p2Id })).has('ticket.create')).toBe(false);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-1 / AC-2 / AC-3 — dispatch needs fleet.job.dispatch
  // -------------------------------------------------------------------------

  it('AC-1: a viewer binding alone is refused by POST …/fleet/jobs with the permissions code', async () => {
    const res = await dispatch('viewer');
    expectPermissionsRefusal(res);
  }, TIMEOUT);

  it('AC-2: the refused viewer dispatch creates no FleetJob', async () => {
    const before = await jobCount();
    await dispatch('viewer');
    expect(await jobCount()).toBe(before);
  }, TIMEOUT);

  it('AC-3: a developer binding alone dispatches a job (201)', async () => {
    const res = await dispatch('developer').expect(201);
    const job = data<{ job: JobRow }>(res).job;
    expect(job.requestedById).toBe(userIds.developer);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-4 / AC-5 / AC-6 — an agent's legacy DEVELOPER entry decides its keys
  // -------------------------------------------------------------------------

  it('AC-4: an agent rostered in p1 with AgentRoleEntry DEVELOPER dispatches a job (201)', async () => {
    const res = await dispatch('p1-developer-agent').expect(201);
    expect(data<{ job: JobRow }>(res).job.state).toBe('QUEUED');
  }, TIMEOUT);

  it('AC-5: that agent dispatch stores requestedById the agent and requestedByType AGENT', async () => {
    const created = data<{ job: JobRow }>(await dispatch('p1-developer-agent').expect(201)).job;

    const row = await db.fleetJob.findUniqueOrThrow({ where: { id: created.id } });
    expect(row).toEqual(expect.objectContaining({ requestedById: developerAgentId, requestedByType: 'AGENT' }));
  }, TIMEOUT);

  it('AC-6: the agent dispatch writes the job.dispatched activity as the agent', async () => {
    const created = data<{ job: JobRow }>(await dispatch('p1-developer-agent').expect(201)).job;

    const row = await db.fleetActivity.findFirstOrThrow({ where: { jobId: created.id, action: 'job.dispatched' } });
    expect(row).toEqual(expect.objectContaining({ actorType: 'AGENT', actorId: developerAgentId }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-7 / AC-8 / AC-9 — the three job reads need fleet.job.read, which a rostered agent holds
  // -------------------------------------------------------------------------

  it('AC-7: a roster-only agent lists the project jobs (200)', async () => {
    await request(server).get(dispatchUrl()).set(auth('p1-roster-agent')).expect(200);
  }, TIMEOUT);

  it('AC-8: a roster-only agent gets a job of the project (200)', async () => {
    const job = await newJob();
    await request(server).get(jobUrl(job.id)).set(auth('p1-roster-agent')).expect(200);
  }, TIMEOUT);

  it('AC-9: a roster-only agent gets the job events (200)', async () => {
    const job = await newJob();
    await request(server).get(`${jobUrl(job.id)}/events`).set(auth('p1-roster-agent')).expect(200);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-10 — requeue needs fleet.job.requeue
  // -------------------------------------------------------------------------

  it('AC-10: a viewer binding alone is refused by requeue, and the job stays FAILED', async () => {
    const job = await newJob({ state: 'FAILED', finishedAt: new Date() });

    const res = await request(server).post(jobUrl(job.id, 'requeue')).set(auth('viewer'));

    expectPermissionsRefusal(res);
    await expect(db.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).resolves.toEqual(
      expect.objectContaining({ state: 'FAILED' }),
    );
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-11 / AC-12 / AC-13 / AC-14 — cancel: the requester or a fleet.job.cancel holder
  // -------------------------------------------------------------------------

  it('AC-11: a viewer cancels its own QUEUED job without fleet.job.cancel (200)', async () => {
    const job = await newJob({ requestedById: userIds.viewer });
    await request(server).post(jobUrl(job.id, 'cancel')).set(auth('viewer')).expect(200);
  }, TIMEOUT);

  it('AC-12: that requester cancel leaves the job CANCELLED', async () => {
    const job = await newJob({ requestedById: userIds.viewer });
    await request(server).post(jobUrl(job.id, 'cancel')).set(auth('viewer')).expect(200);

    await expect(db.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).resolves.toEqual(
      expect.objectContaining({ state: 'CANCELLED' }),
    );
  }, TIMEOUT);

  it("AC-13: a viewer is refused by cancel on another user's job, which stays QUEUED", async () => {
    const job = await newJob({ requestedById: userIds.other });

    const res = await request(server).post(jobUrl(job.id, 'cancel')).set(auth('viewer'));

    expectPermissionsRefusal(res);
    await expect(db.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).resolves.toEqual(
      expect.objectContaining({ state: 'QUEUED' }),
    );
  }, TIMEOUT);

  it("AC-14: a developer cancels another user's QUEUED job (200)", async () => {
    const job = await newJob({ requestedById: userIds.other });

    const res = await request(server).post(jobUrl(job.id, 'cancel')).set(auth('developer')).expect(200);

    expect(data<JobRow>(res).state).toBe('CANCELLED');
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-15 / AC-16 / AC-17 — a dispatch-authorized caller starts its linked ticket
  // -------------------------------------------------------------------------

  it('AC-15: a custom role with dispatch, read and ticket.read dispatches a RUN naming a CREATED ticket (201)', async () => {
    const ticket = await newTicket();

    const res = await dispatch('custom', { ticketRefs: [ticket.ref] }).expect(201);

    expect(data<{ job: { tickets: Array<{ ref: string }> } }>(res).job.tickets).toEqual([expect.objectContaining({ ref: ticket.ref })]);
  }, TIMEOUT);

  it('AC-16: the dispatch-only caller moves the CREATED ticket to IN_PROGRESS without its edge key', async () => {
    const ticket = await newTicket();

    await dispatch('custom', { ticketRefs: [ticket.ref] }).expect(201);

    await expect(db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).resolves.toEqual(
      expect.objectContaining({ status: 'IN_PROGRESS' }),
    );
  }, TIMEOUT);

  it('AC-17: the ticket activity of that start names the dispatching user as actor', async () => {
    const ticket = await newTicket();

    await dispatch('custom', { ticketRefs: [ticket.ref] }).expect(201);

    const activity = await db.ticketActivity.findFirstOrThrow({
      where: { ticketId: ticket.id, action: 'STATUS_CHANGE', toStatus: 'IN_PROGRESS' },
    });
    expect(activity).toEqual(expect.objectContaining({ actorUserId: userIds.custom, actorAgentId: null }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-19 / AC-20 / AC-21 / AC-22 — the ticket fleet-job routes
  // -------------------------------------------------------------------------

  /** A job linked to a ticket, as a dispatch leaves it. */
  const linkedJob = async (): Promise<{ job: JobRow; ticketId: string; ref: string }> => {
    const ticket = await newTicket('IN_PROGRESS');
    const job = await newJob({ state: 'COMPLETED', finishedAt: new Date() });
    await db.fleetJobTicket.create({ data: { jobId: job.id, ticketId: ticket.id } });
    return { job, ticketId: ticket.id, ref: ticket.ref };
  };

  const linkCount = (ticketId: string) => db.fleetJobTicket.count({ where: { ticketId } });

  it('AC-19: a viewer binding alone lists a ticket\'s fleet jobs (200)', async () => {
    const { job, ref } = await linkedJob();

    const res = await request(server).get(`/api/projects/${P1_SLUG}/tickets/${ref}/fleet-jobs`).set(auth('viewer')).expect(200);

    expect(data<Array<{ id: string }>>(res).map((row) => row.id)).toEqual([job.id]);
  }, TIMEOUT);

  it('AC-20: the same viewer is refused by the unlink and the link remains', async () => {
    const { job, ticketId, ref } = await linkedJob();

    const res = await request(server).delete(`/api/projects/${P1_SLUG}/tickets/${ref}/fleet-jobs/${job.id}`).set(auth('viewer'));

    expectPermissionsRefusal(res);
    expect(await linkCount(ticketId)).toBe(1);
  }, TIMEOUT);

  it('AC-21: a developer binding alone unlinks a fleet job from a ticket (204)', async () => {
    const { job, ref } = await linkedJob();
    await request(server).delete(`/api/projects/${P1_SLUG}/tickets/${ref}/fleet-jobs/${job.id}`).set(auth('developer')).expect(204);
  }, TIMEOUT);

  it('AC-22: that developer unlink removes the link', async () => {
    const { job, ticketId, ref } = await linkedJob();
    await request(server).delete(`/api/projects/${P1_SLUG}/tickets/${ref}/fleet-jobs/${job.id}`).set(auth('developer')).expect(204);

    expect(await linkCount(ticketId)).toBe(0);
    expect(await db.fleetJob.count({ where: { id: job.id } })).toBe(1);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-23 — membership is still the first gate
  // -------------------------------------------------------------------------

  it('AC-23: a user with no source in p1 gets 403 projects from the job list', async () => {
    const res = await request(server).get(dispatchUrl()).set(auth('outsider'));

    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    // `projects` has no 40003 sentence, so the i18n lookup answers the key itself.
    expect(res.body.message).toBe('projects.40003');
  }, TIMEOUT);
});

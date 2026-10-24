/**
 * Fleet S5b US-005 — the timeline tool through the real registry and executor against PG, and once through the
 * runner tool route (AC-14, SEAM-3).
 *
 * Acceptance setup: project `web` (key `WEB`) with `dev` as its DEVELOPER and the web thread's creator, project `ops`
 * (one ticket event of its own) with an ADMIN-owned thread job, and project `pag` (key `PAG`) with a thread job of its
 * own for the 21-event page and for the empty window. One enrolled runner holds every RUNNING THREAD job at lease
 * epoch 1. Every event is seeded with an explicit `createdAt` relative to a single `NOW` captured at boot, so the
 * window and the order these ACs assert are the test's, not the clock's.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/assistant-timeline-tool.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, type PrismaClient } from '../../../src/generated/prisma/client';
import { AssistantToolExecutor } from '../../../src/fleet/assistant/assistant-tool.executor';
import { TicketsService } from '../../../src/tickets/tickets.service';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, enrollRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { ThreadJobSeed, seedThreadJobFor } from '../../helpers/thread-fixtures';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
vi.setConfig({ testTimeout: 20_000 });

const DAY_MS = 86_400_000;
/** A `ctx.data(...)` opening line. */
const FENCE_OPEN = /^<<koda-data-[0-9a-f]{16}>>$/;
/** An event's header line: `<ISO time> <eventType>`, plus ` <ref> /<slug>/tickets/<ref>` when its ticket resolves. */
const EVENT_LINE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z (?:ticket_event|agent_event|decision_event)(?: \S+ \/\S+)?$/;

/** Every event header line of a result, in order. */
const headers = (content: string): string[] => content.split('\n').filter((line) => EVENT_LINE.test(line));

/** The header line of the event whose fenced action is `action`; undefined when the answer does not hold it. */
const headerFor = (content: string, action: string): string | undefined => {
  const lines = content.split('\n');
  const at = lines.indexOf(action);
  // The action line sits inside its fence, so the event's header is two lines above it.
  if (at < 1 || !FENCE_OPEN.test(lines[at - 1] ?? '')) return undefined;
  return lines[at - 2];
};

describeIntegration('fleet assistant timeline tool (PG, US-005)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  let thread: ThreadJobSeed;
  let opsJobId: string;
  let pagJobId: string;
  let executor: AssistantToolExecutor;
  let tickets: TicketsService;
  const NOW = new Date();
  const saved: Record<string, string | undefined> = {};

  /** The tickets the ACs resolve refs for, by the name each AC uses. */
  let web3: { id: string };
  let web7: { id: string };
  let web9: { id: string };
  let ops1: { id: string };
  /** The events the ACs read, by the name each AC uses. */
  let recentEvent: { createdAt: Date };
  let deletedTicketEvent: { createdAt: Date };
  let oldEvent: { createdAt: Date };
  let decision: { createdAt: Date };
  let opsEvent: { createdAt: Date };
  /** The 21-event page's events, oldest first, so `bulk[20]` is the newest and the first page's head. */
  const bulk: Array<{ id: string; createdAt: Date }> = [];

  const daysAgo = (days: number, minutes = 0): Date => new Date(NOW.getTime() - days * DAY_MS + minutes * 60_000);

  const ticket = (projectId: string, number: number, title: string, deletedAt: Date | null = null) =>
    prisma.ticket.create({ data: { projectId, number, type: 'BUG', title, status: 'CREATED', priority: 'MEDIUM', deletedAt } });

  const ticketEvent = (projectId: string, ticketId: string | null, action: string, createdAt: Date) =>
    prisma.ticketEvent.create({ data: { projectId, ticketId, action, actorId: 'actor-1', actorType: 'user', source: 'api', createdAt } });

  const agentEvent = (projectId: string, action: string, createdAt: Date) =>
    prisma.agentEvent.create({ data: { projectId, agentId: 'agent-1', action, actorId: 'agent-1', source: 'internal', createdAt } });

  const decisionEvent = (projectId: string, action: string, createdAt: Date) =>
    prisma.decisionEvent.create({ data: { projectId, agentId: 'agent-1', action, decision: 'decided', source: 'internal', createdAt } });

  /** A RUNNING THREAD job of `projectId` owned by `creatorId`: what fixes the tool's project scope (S5b-R7). */
  const threadJobIn = async (projectId: string, repoId: string, creatorId: string, feature: string): Promise<string> => {
    const created = await prisma.chatThread.create({
      data: {
        projectId, repoId, baseRef: 'trunk', feature, title: 'Timeline fixture', createdById: creatorId,
        backend: { kind: 'native', model: 'm1' }, skills: [], specPath: `.nax/features/${feature}/spec.md`,
      },
    });
    const job = await prisma.fleetJob.create({
      data: {
        projectId, repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${created.id}`, profiles: [],
        selectorLabels: [], maxCostUsd: new Prisma.Decimal(5), requestedById: creatorId, state: 'RUNNING',
        runnerId: runner.runnerId, leaseEpoch: 1, firstStartedAt: new Date(), threadId: created.id,
      },
    });
    await prisma.fleetThreadTurn.create({
      data: {
        jobId: job.id, threadId: created.id, action: 'SESSION', instructions: 'go',
        backend: { kind: 'native', model: 'm1' }, skills: [], resume: false,
      },
    });
    return job.id;
  };

  const call = (toolCallId: string, input: unknown, jobId: string = thread.jobId) =>
    executor.execute({ jobId, toolCallId, name: 'koda_timeline', input });

  const toolUrl = (jobId: string, leaseEpoch = 1): string =>
    `/api/fleet/runner/jobs/${jobId}/tools/koda_timeline?leaseEpoch=${leaseEpoch}`;

  beforeAll(async () => {
    saved['FLEET_THREADS_ENABLED'] = process.env['FLEET_THREADS_ENABLED'];
    process.env['FLEET_THREADS_ENABLED'] = 'true';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'timeline-tool-runner');
    thread = await seedThreadJobFor(prisma, world, runner, { feature: 'us005-timeline' });
    executor = app.get<AssistantToolExecutor>(AssistantToolExecutor, { strict: false });
    tickets = app.get<TicketsService>(TicketsService, { strict: false });

    // AC-7: the other project's scope, driven by the global ADMIN.
    opsJobId = await threadJobIn(world.opsProjectId, world.foreignRepoId, world.ids.root, 'us005-timeline-ops');
    // AC-8/AC-11: a scope of its own, so the 21 events never crowd the events the other ACs read out of a page.
    const pag = await prisma.project.create({ data: { name: 'pag', slug: 'pag', key: 'PAG' } });
    const pagRepo = await prisma.fleetRepo.create({
      data: {
        projectId: pag.id, provider: 'github', owner: 'acme', name: 'pag', defaultBranch: 'main',
        githubInstallationId: BigInt(77), createdById: world.ids.root,
      },
    });
    pagJobId = await threadJobIn(pag.id, pagRepo.id, world.ids.root, 'us005-timeline-pag');

    // AC-1/AC-2/AC-10: one ticket event a day old, one of a soft-deleted ticket two days old, one eight days old.
    web3 = await ticket(world.projectId, 3, 'Timeline probe');
    web7 = await ticket(world.projectId, 7, 'Live probe');
    web9 = await ticket(world.projectId, 9, 'Deleted probe', new Date());
    recentEvent = await ticketEvent(world.projectId, web3.id, 'WEB3_CREATED', daysAgo(1));
    deletedTicketEvent = await ticketEvent(world.projectId, web9.id, 'DELETED_TICKET_EVENT', daysAgo(2));
    oldEvent = await ticketEvent(world.projectId, web3.id, 'OLD_EVENT', daysAgo(8));
    // AC-6/AC-7: the other two tables, so a type filter and the cross-project scope have something to leave out.
    await agentEvent(world.projectId, 'AGENT_INDEXED', daysAgo(3));
    decision = await decisionEvent(world.projectId, 'DECISION_MADE', daysAgo(4));
    // AC-4/AC-7: the foreign project's own ticket and event.
    ops1 = await ticket(world.opsProjectId, 1, 'Ops probe');
    opsEvent = await ticketEvent(world.opsProjectId, ops1.id, 'OPS_CREATED', daysAgo(2));

    // AC-8/AC-11: 21 events of one ticket, roughly six days old — inside the default week, outside a one-day window.
    const pag1 = await ticket(pag.id, 1, 'Pagination probe');
    for (let index = 1; index <= 21; index += 1) {
      const created = await ticketEvent(pag.id, pag1.id, `PAG_EVENT_${String(index).padStart(2, '0')}`, daysAgo(6, index));
      bulk.push({ id: created.id, createdAt: created.createdAt });
    }
  }, 60_000);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      if (saved['FLEET_THREADS_ENABLED'] === undefined) delete process.env['FLEET_THREADS_ENABLED'];
      else process.env['FLEET_THREADS_ENABLED'] = saved['FLEET_THREADS_ENABLED'];
    }
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('AC-1: koda_timeline {} names the ref and the web path of the event ticket, then fences the action', async () => {
    const result = await call('ac1', {});

    expect(result.isError).toBe(false);
    const lines = result.content.split('\n');
    expect(lines[0]).toBe(`${recentEvent.createdAt.toISOString()} ticket_event WEB-3 /web/tickets/WEB-3`);
    expect(lines[1]).toMatch(FENCE_OPEN);
    expect(lines[2]).toBe('WEB3_CREATED');
    expect(lines[3]).toMatch(/^<<end-koda-data-[0-9a-f]{16}>>$/);
  });

  it('AC-2: koda_timeline {} leaves the 8-day-old event out, days 10 includes it', async () => {
    const week = await call('ac2a', {});

    expect(week.isError).toBe(false);
    expect(headerFor(week.content, 'OLD_EVENT')).toBeUndefined();
    expect(week.content).not.toContain('OLD_EVENT');
    // The window is not empty: the day-old event is the answer's first line.
    expect(headerFor(week.content, 'WEB3_CREATED')).toBe(`${recentEvent.createdAt.toISOString()} ticket_event WEB-3 /web/tickets/WEB-3`);

    const tenDays = await call('ac2b', { days: 10 });

    expect(tenDays.isError).toBe(false);
    expect(headerFor(tenDays.content, 'OLD_EVENT')).toBe(`${oldEvent.createdAt.toISOString()} ticket_event WEB-3 /web/tickets/WEB-3`);
  });

  it('AC-3: koda_timeline { ticket: "WEB-3" } answers the ticket events of WEB-3 only', async () => {
    const result = await call('ac3', { ticket: 'WEB-3' });

    expect(result.isError).toBe(false);
    // Exactly one WEB-3 event is inside the default week, and only that table was read.
    expect(headers(result.content)).toEqual([`${recentEvent.createdAt.toISOString()} ticket_event WEB-3 /web/tickets/WEB-3`]);
    expect(result.content).not.toContain('DELETED_TICKET_EVENT');
    expect(result.content).not.toContain('AGENT_INDEXED');
    expect(result.content).not.toContain('DECISION_MADE');
  });

  it('AC-4: a ref of another project answers not_found', async () => {
    // `OPS-1` exists, but in project `ops`: the thread's project is the whole scope.
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: ops1.id } })).toMatchObject({ projectId: world.opsProjectId });

    const result = await call('ac4', { ticket: 'OPS-1' });

    expect(result).toMatchObject({ isError: true, content: 'not_found' });
  });

  it('AC-5: a ref no ticket has answers not_found', async () => {
    const result = await call('ac5', { ticket: 'WEB-999' });

    expect(result).toMatchObject({ isError: true, content: 'not_found' });
    expect(await prisma.ticket.count({ where: { projectId: world.projectId, number: 999 } })).toBe(0);
  });

  it('AC-6: koda_timeline { eventTypes: ["decision_event"] } answers decision events only', async () => {
    const result = await call('ac6', { eventTypes: ['decision_event'] });

    expect(result.isError).toBe(false);
    expect(headers(result.content)).toEqual([`${decision.createdAt.toISOString()} decision_event`]);
    expect(result.content).not.toContain('WEB3_CREATED');
    expect(result.content).not.toContain('AGENT_INDEXED');
  });

  it('AC-7: koda_timeline {} never answers an event of another project', async () => {
    const web = await call('ac7', {});

    expect(headers(web.content)).toHaveLength(4);
    expect(web.content).not.toContain('OPS_CREATED');

    const ops = await call('ac7-ops', {}, opsJobId);

    expect(ops.isError).toBe(false);
    expect(headers(ops.content)).toEqual([`${opsEvent.createdAt.toISOString()} ticket_event OPS-1 /ops/tickets/OPS-1`]);
    for (const action of ['WEB3_CREATED', 'DELETED_TICKET_EVENT', 'AGENT_INDEXED', 'DECISION_MADE']) {
      expect(ops.content).not.toContain(action);
    }
  });

  it('AC-8: 21 events answer 20 plus the cursor line, and the cursor answers the 21st', async () => {
    const first = await call('ac8a', {}, pagJobId);

    expect(first.isError).toBe(false);
    const firstPage = headers(first.content);
    expect(firstPage).toHaveLength(20);
    // Newest first: the 21 seeded events are `PAG_EVENT_01` (oldest) .. `PAG_EVENT_21` (newest).
    expect(firstPage[0]).toBe(`${bulk[20]?.createdAt.toISOString()} ticket_event PAG-1 /pag/tickets/PAG-1`);
    expect(firstPage[19]).toBe(`${bulk[1]?.createdAt.toISOString()} ticket_event PAG-1 /pag/tickets/PAG-1`);
    expect(first.content).not.toContain('PAG_EVENT_01');
    const cursor = first.content.split('\n').at(-1) ?? '';
    expect(cursor).toMatch(/^more: call koda_timeline with cursor \S+$/);

    // The same scope, the cursor it just handed back: a cursor of another project's page would answer `no events`.
    const second = await call('ac8b', { cursor: cursor.replace('more: call koda_timeline with cursor ', '') }, pagJobId);

    expect(second.isError).toBe(false);
    expect(second.content).not.toBe('no events');
    expect(headers(second.content)).toEqual([`${bulk[0]?.createdAt.toISOString()} ticket_event PAG-1 /pag/tickets/PAG-1`]);
    expect(second.content).not.toContain('more:');
  });

  it('AC-9: a cursor decodeTimelineCursor rejects answers invalid_input: cursor', async () => {
    const result = await call('ac9', { cursor: 'not-a-cursor' });

    expect(result).toMatchObject({ isError: true, content: 'invalid_input: cursor' });
  });

  it('AC-10: an event of a soft-deleted ticket is emitted without a ref or a path', async () => {
    const result = await call('ac10', {});

    expect(result.isError).toBe(false);
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: web9.id } })).toMatchObject({ deletedAt: expect.any(Date) });
    expect(headerFor(result.content, 'DELETED_TICKET_EVENT')).toBe(`${deletedTicketEvent.createdAt.toISOString()} ticket_event`);
  });

  it('AC-11: a project with no event in the window answers the single line no events', async () => {
    // Every `pag` event is roughly six days old, so a one-day window is empty.
    expect(await prisma.ticketEvent.count({ where: { action: { startsWith: 'PAG_EVENT_' } } })).toBe(21);
    // The scope is not empty — it is the window: the same scope over the default week answers a full page.
    const wide = await call('ac11-wide', {}, pagJobId);
    expect(wide.isError).toBe(false);
    expect(headers(wide.content)).toHaveLength(20);

    const result = await call('ac11', { days: 1 }, pagJobId);

    expect(result.isError).toBe(false);
    expect(result.content).toBe('no events');
  });

  it('AC-13: findRefsByIds answers the project refs and never the other project\u2019s ticket', async () => {
    const refs = await tickets.findRefsByIds(world.projectId, [web3.id, web7.id, ops1.id]);

    expect(refs.size).toBe(2);
    expect(refs.get(web3.id)).toBe('WEB-3');
    expect(refs.get(web7.id)).toBe('WEB-7');
    expect(refs.has(ops1.id)).toBe(false);
  });

  it('AC-14: the holder of a RUNNING THREAD job reads the timeline through the route in one ref read', async () => {
    const spy = vi.spyOn(tickets, 'findRefsByIds');
    try {
      const res = await request(server)
        .post(toolUrl(thread.jobId))
        .set({ Authorization: `Bearer ${runner.apiKey}` })
        .send({ toolCallId: 't1', input: {} })
        .expect(200);

      expect(data<{ isError: boolean }>(res)).toMatchObject({ isError: false });
      expect(data<{ content: string }>(res).content).toContain('WEB-3');
      expect(spy).toHaveBeenCalledTimes(1);
      // The page's two ticket events, in the answer's own order: one read for both.
      expect(spy).toHaveBeenCalledWith(world.projectId, [web3.id, web9.id]);
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * Fleet S5b US-003 — the ticket read tools through the real registry and executor against PG.
 *
 * Acceptance setup: project `web` (key WEB) with `dev` as its DEVELOPER and the thread's creator, project `ops`
 * (key OPS), and one RUNNING THREAD job of project `web` held by an inserted runner. The tools are found by name in
 * `AssistantToolRegistry`, which `AssistantModule` fills through `TicketTools.onModuleInit` while the app boots.
 *
 * Run: cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/fleet/assistant-ticket-tools.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { AssistantToolExecutor } from '../../../src/fleet/assistant/assistant-tool.executor';
import { TicketsService } from '../../../src/tickets/tickets.service';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { seedThreadJobFor, ThreadJobSeed } from '../../helpers/thread-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
vi.setConfig({ testTimeout: 20_000 });

/** Every line of a list result: `<REF> <STATUS> <PRIORITY> <TYPE> /<slug>/tickets/<ref>`. */
const LIST_LINE = /^([A-Z][A-Z0-9]*-[1-9][0-9]*) [A-Z_]+ [A-Z]+ [A-Z]+ \//;
/** A `ctx.data(...)` opening line. */
const FENCE_OPEN = /^<<koda-data-[0-9a-f]{16}>>$/;

/** The refs a list result names, in order. */
const refsIn = (content: string): string[] => {
  const refs: string[] = [];
  for (const line of content.split('\n')) {
    const [, ref] = LIST_LINE.exec(line) ?? [];
    if (ref) refs.push(ref);
  }
  return refs;
};

/** The payloads of every `ctx.data(...)` fence in a result, in order. */
const fencedLines = (content: string): string[] => {
  const lines = content.split('\n');
  const values: string[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1];
    const current = lines[index];
    if (previous !== undefined && current !== undefined && FENCE_OPEN.test(previous)) values.push(current);
  }
  return values;
};

describeIntegration('fleet assistant ticket tools (PG, US-003)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let thread: ThreadJobSeed;
  let executor: AssistantToolExecutor;
  let ticketsService: TicketsService;

  /** The ticket row of project `web` (or `ops`), at an explicit number so every ref is predictable. */
  const ticket = (
    projectId: string,
    data: { number: number; title: string; type?: string; status?: string; priority?: string; description?: string; assignedToUserId?: string; deletedAt?: Date },
  ) =>
    prisma.ticket.create({
      data: { projectId, type: 'BUG', status: 'CREATED', priority: 'MEDIUM', ...data },
    });

  const call = (toolCallId: string, name: string, input: unknown) =>
    executor.execute({ jobId: thread.jobId, toolCallId, name, input });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    const runner = await insertRunner(prisma, { createdById: world.ids.root });
    thread = await seedThreadJobFor(prisma, world, { runnerId: runner.id, apiKey: 'unused' }, { feature: 'us003-tickets' });
    executor = app.get<AssistantToolExecutor>(AssistantToolExecutor, { strict: false });
    ticketsService = app.get<TicketsService>(TicketsService, { strict: false });

    // WEB-1: the IN_PROGRESS ticket the search and detail ACs read.
    await ticket(world.projectId, {
      number: 1, type: 'BUG', status: 'IN_PROGRESS', priority: 'HIGH', title: 'Fix login page',
      description: 'The login form rejects valid credentials.', assignedToUserId: world.ids.dev,
    });
    // WEB-2: soft-deleted but still IN_PROGRESS, so no read may return it.
    await ticket(world.projectId, {
      number: 2, type: 'BUG', status: 'IN_PROGRESS', priority: 'LOW', title: 'Deleted ticket', deletedAt: new Date(),
    });
    await ticket(world.projectId, { number: 3, type: 'TASK', status: 'IN_PROGRESS', priority: 'MEDIUM', title: 'Ship the release notes' });
    await ticket(world.projectId, {
      number: 4, type: 'ENHANCEMENT', status: 'CREATED', priority: 'MEDIUM', title: 'Add billing', assignedToUserId: world.ids.viewer,
    });
    await ticket(world.projectId, {
      number: 10, type: 'QUESTION', status: 'VERIFIED', priority: 'CRITICAL', title: 'Ask about quotas', assignedToUserId: world.ids.dev,
    });
    // WEB-11 carries the merged PR link (AC-10) and 12 comments (AC-11).
    const linked = await ticket(world.projectId, {
      number: 11, type: 'BUG', status: 'CLOSED', priority: 'MEDIUM', title: 'Linked ticket',
      description: 'Carries a merged PR and twelve comments.',
    });
    await prisma.ticketLink.create({
      data: {
        ticketId: linked.id, url: 'https://github.com/acme/app/pull/7', provider: 'github',
        externalRef: 'acme/app#7', prState: 'merged', prNumber: 7, linkType: 'pr',
      },
    });
    for (let index = 1; index <= 12; index += 1) {
      await prisma.comment.create({
        data: {
          ticketId: linked.id, body: `comment body ${String(index).padStart(2, '0')}`, type: 'GENERAL',
          authorUserId: world.ids.dev, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
        },
      });
    }
    // 21 tickets the AC-5 page bound is measured on; unassigned, so they never enter the `assignee: me` answer.
    for (let number = 100; number <= 120; number += 1) {
      await ticket(world.projectId, { number, type: 'TASK', status: 'CREATED', priority: 'LOW', title: `bulk ticket ${number}` });
    }
    await ticket(world.opsProjectId, { number: 1, type: 'BUG', status: 'IN_PROGRESS', priority: 'LOW', title: 'ops ticket' });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('AC-2: koda_search_tickets { status: IN_PROGRESS } names the IN_PROGRESS tickets and omits the CREATED one', async () => {
    const result = await call('ac2', 'koda_search_tickets', { status: 'IN_PROGRESS' });
    expect(result.isError).toBe(false);
    expect(refsIn(result.content)).toEqual(['WEB-1', 'WEB-3']);
    expect(result.content).toContain('/web/tickets/WEB-1');
    expect(result.content).not.toContain('WEB-4');
  });

  it('AC-3: koda_search_tickets { text: "LOGIN" } matches the title case-insensitively', async () => {
    const result = await call('ac3', 'koda_search_tickets', { text: 'LOGIN' });
    expect(result.isError).toBe(false);
    expect(refsIn(result.content)).toEqual(['WEB-1']);
    expect(result.content).toContain('Fix login page');
    expect(result.content).not.toContain('Add billing');
  });

  it('AC-4: koda_search_tickets { assignee: "me" } answers only the creator\'s own tickets', async () => {
    const result = await call('ac4', 'koda_search_tickets', { assignee: 'me' });
    expect(result.isError).toBe(false);
    const assigned = await prisma.ticket.findMany({
      where: { projectId: world.projectId, assignedToUserId: world.ids.dev, deletedAt: null },
      orderBy: { number: 'asc' },
      select: { number: true },
    });
    expect(assigned.length).toBeGreaterThan(0);
    expect(refsIn(result.content)).toEqual(assigned.map((row) => `WEB-${row.number}`));
    expect(refsIn(result.content)).not.toContain('WEB-3');
    expect(refsIn(result.content)).not.toContain('WEB-4');
  });

  it('AC-5: koda_search_tickets over 21 matches answers 20 refs and asks for page 2', async () => {
    const result = await call('ac5', 'koda_search_tickets', { text: 'bulk' });
    expect(result.isError).toBe(false);
    expect(refsIn(result.content)).toHaveLength(20);
    expect(result.content.split('\n').at(-1)).toBe('more: call koda_search_tickets with page 2');
  });

  it('AC-6: koda_search_tickets wraps every title in a koda data fence', async () => {
    const result = await call('ac6', 'koda_search_tickets', { status: 'IN_PROGRESS' });
    expect(fencedLines(result.content)).toContain('Fix login page');
    expect(fencedLines(result.content)).toContain('Ship the release notes');
    expect(result.content).toMatch(/<<koda-data-[0-9a-f]{16}>>\nFix login page\n<<end-koda-data-[0-9a-f]{16}>>/);
  });

  it('AC-9: koda_get_ticket { ref: "WEB-1" } names the ticket fields, its path and its fenced description', async () => {
    const result = await call('ac9', 'koda_get_ticket', { ref: 'WEB-1' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('IN_PROGRESS');
    expect(result.content).toContain('HIGH');
    expect(result.content).toContain('BUG');
    expect(result.content).toContain('/web/tickets/WEB-1');
    expect(result.content).toContain(`assignee: user ${world.ids.dev}`);
    expect(fencedLines(result.content)).toContain('The login form rejects valid credentials.');
  });

  it('AC-10: koda_get_ticket names the PR state and fences the link URL', async () => {
    const result = await call('ac10', 'koda_get_ticket', { ref: 'WEB-11' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('merged');
    expect(fencedLines(result.content)).toContain('https://github.com/acme/app/pull/7');
  });

  it('AC-11: koda_get_ticket answers the last 10 comments in creation order and not the first two', async () => {
    const result = await call('ac11', 'koda_get_ticket', { ref: 'WEB-11' });
    expect(result.isError).toBe(false);
    const bodies = fencedLines(result.content).filter((line) => line.startsWith('comment body '));
    expect(bodies).toEqual(Array.from({ length: 10 }, (_, index) => `comment body ${String(index + 3).padStart(2, '0')}`));
    expect(result.content).not.toContain('comment body 01');
    expect(result.content).not.toContain('comment body 02');
  });

  it('AC-12: koda_get_ticket for a ticket of another project answers not_found', async () => {
    const result = await call('ac12', 'koda_get_ticket', { ref: 'OPS-1' });
    expect(result.isError).toBe(true);
    expect(result.content).toBe('not_found');
  });

  it('AC-15: without titleContains, findAll keeps project scope, status, soft-delete and number order', async () => {
    const page = await ticketsService.findAll('web', { status: 'IN_PROGRESS' }, { current: 1, size: 20 });
    expect(page.records.map((record) => record.ref)).toEqual(['WEB-1', 'WEB-3']);
  });

  it('titleContains matches the title case-insensitively through the service', async () => {
    const page = await ticketsService.findAll('web', { titleContains: 'LOGIN PAGE' }, { current: 1, size: 20 });
    expect(page.records.map((record) => record.ref)).toEqual(['WEB-1']);
  });
});

/**
 * Fleet S5b 2b1 US-003 — `koda_create_tickets` through the real runner tool route against PG.
 *
 * Every call enters at `POST /fleet/runner/jobs/:jobId/tools/koda_create_tickets?leaseEpoch=<n>` with the real
 * runner key of the runner that holds a RUNNING THREAD job, and every decide enters the real project route
 * `POST /projects/web/fleet/approvals/:approvalId/decide`, so the ACs drive the whole path: runner authentication,
 * the lease fence, the tool registry `TicketWriteTools` filled at boot, the executor's write-tool branch, the propose
 * service and — on approve — `TicketsService.create` for real. Each test proposes its own batch with its own
 * `toolCallId` and its own titles, so it reads only what it wrote.
 *
 * Acceptance setup: project `web` (its key changed to `KODA`, so the created refs are `KODA-<n>`), `dev` as its
 * DEVELOPER and the thread creator, and one RUNNING REPO THREAD job held by an enrolled runner.
 * FLEET_THREADS_ENABLED=true before boot, or the route answers 409.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/assistant-create-tickets-tool.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, enrollRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { seedThreadJobFor, ThreadJobSeed } from '../../helpers/thread-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });
const ENV = ['FLEET_THREADS_ENABLED'] as const;

/** The web project's key, so the first created ticket is `KODA-1`. */
const WEB_KEY = 'KODA';
const TOOL = 'koda_create_tickets';
const APPROVALS = '/api/projects/web/fleet/approvals';
/** The route's answer: `{ content, isError }` data, whatever the status. */
interface ToolResultBody { content: string; isError: boolean }

describeIntegration('fleet assistant create tickets tool (PG, US-003)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runnerKey: string;
  let repo: ThreadJobSeed;
  const saved: Record<string, string | undefined> = {};

  /** POSTs one `koda_create_tickets` call on the held job as its runner, at the job's lease epoch 1. */
  const callTool = (toolCallId: string, input: unknown) =>
    request(server)
      .post(`/api/fleet/runner/jobs/${repo.jobId}/tools/${TOOL}?leaseEpoch=1`)
      .set({ Authorization: `Bearer ${runnerKey}` })
      .send({ toolCallId, input });

  const resultOf = (res: request.Response): ToolResultBody => data<ToolResultBody>(res);

  const actionOf = (toolCallId: string) =>
    prisma.pendingAction.findUniqueOrThrow({ where: { jobId_toolCallId: { jobId: repo.jobId, toolCallId } } });

  /** One accepted proposal: answers the stored action, asserting the call itself was answered `pending`. */
  const propose = async (toolCallId: string, tickets: unknown[]) => {
    const { content, isError } = resultOf(await callTool(toolCallId, { tickets }).expect(200));
    expect(isError).toBe(false);
    expect(content.startsWith('pending ')).toBe(true);
    return actionOf(toolCallId);
  };

  /** `dev` decides one approval; answers the decide response. */
  const decide = (approvalId: string, decision: string) =>
    request(server).post(`${APPROVALS}/${approvalId}/decide`).set({ Authorization: `Bearer ${world.tokens.dev}` }).send({ decision });

  /** The project's tickets of the given titles, oldest first. */
  const ticketsTitled = (titles: string[]) =>
    prisma.ticket.findMany({ where: { projectId: world.projectId, title: { in: titles } }, orderBy: { number: 'asc' } });

  beforeAll(async () => {
    saved['FLEET_THREADS_ENABLED'] = process.env['FLEET_THREADS_ENABLED'];
    process.env['FLEET_THREADS_ENABLED'] = 'true';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    // The acceptance refs are `KODA-<n>`, so the web project answers the `KODA` key.
    await prisma.project.update({ where: { id: world.projectId }, data: { key: WEB_KEY } });
    const runner = await enrollRunner(server, world.tokens.root, 'create-tickets-runner');
    await prisma.runner.update({
      where: { id: runner.runnerId }, data: { protocolVersion: 4, enabled: true, lastSeenAt: new Date() },
    });
    runnerKey = runner.apiKey;
    repo = await seedThreadJobFor(prisma, world, { runnerId: runner.runnerId, apiKey: runner.apiKey }, { feature: 'create-tickets' });
  }, 120_000);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      for (const key of ENV) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  it('AC-12: a runner holding a RUNNING REPO THREAD job proposes two tickets and is answered pending', async () => {
    const tickets = [
      { type: 'TASK', title: 'Add login' },
      { type: 'BUG', title: 'Fix logout', priority: 'HIGH' },
    ];

    const res = await callTool('ac12', { tickets }).expect(200);

    const { content, isError } = resultOf(res);
    expect(isError).toBe(false);
    expect(content.startsWith('pending ')).toBe(true);
    const action = await actionOf('ac12');
    expect(content).toBe(`pending ${action.id}: awaiting user approval; do not retry`);
    expect(action).toMatchObject({ tool: TOOL, status: 'PENDING' });
    // Nothing is created while the action waits for the user.
    expect(await prisma.ticket.count({ where: { projectId: world.projectId, title: { in: ['Add login', 'Fix logout'] } } })).toBe(0);
    expect(action.preview.split('\n')).toEqual([
      'Create 2 ticket(s) in web:',
      '1. [TASK, MEDIUM] Add login',
      '2. [BUG, HIGH] Fix logout',
    ]);
  });

  it('AC-13: after dev approves, the project\'s two newest tickets are the two proposed titles, oldest first', async () => {
    const titles = ['Record the ADR', 'Write the runbook'];
    const action = await propose('ac13', [
      { type: 'ENHANCEMENT', title: titles[0] },
      { type: 'QUESTION', title: titles[1], description: 'where does this live?' },
    ]);

    await decide(action.approvalId, 'approve').expect(200);

    const newest = await prisma.ticket.findMany({
      where: { projectId: world.projectId }, orderBy: { number: 'desc' }, take: 2,
    });
    expect(newest.map((ticket) => ticket.title).reverse()).toEqual(titles);
  });

  it('AC-14: each ticket created by that approval was created by dev', async () => {
    const titles = ['Split the monolith', 'Retire the queue'];
    const action = await propose('ac14', [
      { type: 'TASK', title: titles[0], priority: 'CRITICAL' },
      { type: 'TASK', title: titles[1], priority: 'LOW' },
    ]);

    await decide(action.approvalId, 'approve').expect(200);

    const created = await ticketsTitled(titles);
    expect(created).toHaveLength(2);
    for (const ticket of created) {
      expect(ticket.createdByUserId).toBe(world.ids.dev);
      expect(ticket.createdByAgentId).toBeNull();
    }
  });

  it('the approved action answers one created line per ticket, and each ticket keeps what was proposed', async () => {
    const titles = ['Add SSO', 'Add SCIM'];
    const action = await propose('ac-created-lines', [
      { type: 'ENHANCEMENT', title: titles[0], description: 'with okta\nand google', priority: 'HIGH' },
      { type: 'ENHANCEMENT', title: titles[1] },
    ]);

    await decide(action.approvalId, 'approve').expect(200);

    const created = await ticketsTitled(titles);
    const numbers = created.map((ticket) => ticket.number);
    expect(numbers[1]).toBe((numbers[0] ?? 0) + 1);
    const refs = numbers.map((number) => `${WEB_KEY}-${number}`);
    expect(await prisma.pendingAction.findUniqueOrThrow({ where: { id: action.id } })).toMatchObject({
      status: 'EXECUTED',
      result: refs.map((ref) => `created ${ref} /web/tickets/${ref}`).join('\n'),
    });
    expect(created[0]).toMatchObject({ type: 'ENHANCEMENT', priority: 'HIGH', description: 'with okta\nand google' });
    expect(created[1]).toMatchObject({ type: 'ENHANCEMENT', priority: 'MEDIUM', description: null });
  });

  it('a ticket of an unknown type answers invalid_input with the field\'s own reason and stores no action', async () => {
    const { content, isError } = resultOf(await callTool('ac-invalid', {
      tickets: [{ type: 'TASK', title: 'a' }, { type: 'EPIC', title: 'b' }],
    }).expect(200));

    expect({ content, isError }).toEqual({ content: 'invalid_input: tickets[1].type', isError: true });
    expect(await prisma.pendingAction.count({ where: { jobId: repo.jobId, toolCallId: 'ac-invalid' } })).toBe(0);
    expect(await prisma.ticket.count({ where: { projectId: world.projectId, title: 'a' } })).toBe(0);
  });
});

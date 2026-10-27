import { findThreadAction } from '../../helpers/assistant-request';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet S5b 2b1 US-004 — `koda_update_ticket` through the real runner tool route against PG.
 *
 * Every call enters at `POST /fleet/runner/jobs/:jobId/tools/koda_update_ticket?leaseEpoch=<n>` with the real runner
 * key of the runner that holds a RUNNING THREAD job, and every decide enters the real project route
 * `POST /projects/web/fleet/approvals/:approvalId/decisions`, so the ACs drive the whole path: runner authentication,
 * the lease fence, the tool registry `TicketWriteTools` filled at boot, the executor's write-tool branch, the propose
 * service and — on approve — `TicketsService.update` for real. Each test sets its own ticket status before it
 * proposes, so it reads only the state it wrote.
 *
 * Acceptance setup: project `web` (its key changed to `KODA`, so the acceptance ref `KODA-1` resolves), `dev` as its
 * DEVELOPER and the thread creator, ticket `KODA-1`, and one RUNNING REPO THREAD job held by an enrolled runner.
 * FLEET_THREADS_ENABLED=true before boot, or the route answers 409.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/assistant-update-ticket-tool.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, enrollRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { seedThreadJobFor, ThreadJobSeed } from '../../helpers/thread-fixtures';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });
const ENV = ['FLEET_THREADS_ENABLED'] as const;

/** The web project's key, so the acceptance ref is `KODA-1`. */
const WEB_KEY = 'KODA';
const TOOL = 'koda_update_ticket';
const APPROVALS = '/api/approvals';
/** The route's answer: `{ content, isError }` data, whatever the status. */
interface ToolResultBody { content: string; isError: boolean }

describeIntegration('fleet assistant update ticket tool (PG, US-004)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runnerKey: string;
  let repo: ThreadJobSeed;
  let ticketId: string;
  const saved: Record<string, string | undefined> = {};

  /** POSTs one `koda_update_ticket` call on the held job as its runner, at the job's lease epoch 1. */
  const callTool = (toolCallId: string, input: unknown) =>
    request(server)
      .post(`/api/fleet/runner/jobs/${repo.jobId}/tools/${TOOL}?leaseEpoch=1`)
      .set({ Authorization: `Bearer ${runnerKey}` })
      .send({ toolCallId, input });

  const resultOf = (res: request.Response): ToolResultBody => data<ToolResultBody>(res);

  const actionOf = (toolCallId: string) =>
    findThreadAction(prisma, { jobId: repo.jobId, toolCallId });

  /** The ticket's own row, as the ACs compare it. */
  const ticketState = () =>
    prisma.ticket.findUniqueOrThrow({ where: { id: ticketId }, select: { status: true, priority: true, title: true } });

  /** AC setup: the test's own ticket state, written directly so no transition rule stands in the way. */
  const setTicket = (over: { status?: string; priority?: string; title?: string }) =>
    prisma.ticket.update({ where: { id: ticketId }, data: over });

  /** One accepted proposal: answers the stored action, asserting the call itself was answered `pending`. */
  const propose = async (toolCallId: string, input: unknown) => {
    const { content, isError } = resultOf(await callTool(toolCallId, input).expect(200));
    expect(isError).toBe(false);
    expect(content.startsWith('pending ')).toBe(true);
    return actionOf(toolCallId);
  };

  /** `dev` decides one approval; answers the decide response. */
  const decide = (approvalId: string, decision: string) =>
    request(server).post(`${APPROVALS}/${approvalId}/decisions`).set({ Authorization: `Bearer ${world.tokens.dev}` }).send({ decision });

  beforeAll(async () => {
    saved['FLEET_THREADS_ENABLED'] = process.env['FLEET_THREADS_ENABLED'];
    process.env['FLEET_THREADS_ENABLED'] = 'true';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    await grantKeys(prisma, { type: 'USER', id: world.ids.dev }, ['approval.decide'], world.projectId);
    // The acceptance ref is `KODA-1`, so the web project answers the `KODA` key.
    await prisma.project.update({ where: { id: world.projectId }, data: { key: WEB_KEY } });
    ticketId = (await prisma.ticket.create({
      data: {
        projectId: world.projectId, number: 1, type: 'BUG', title: 'Fix login', description: 'the old text',
        status: 'CREATED', priority: 'MEDIUM',
      },
    })).id;
    const runner = await enrollRunner(server, world.tokens.root, 'update-ticket-runner');
    await prisma.runner.update({
      where: { id: runner.runnerId }, data: { protocolVersion: 4, enabled: true, lastSeenAt: new Date() },
    });
    runnerKey = runner.apiKey;
    repo = await seedThreadJobFor(prisma, world, { runnerId: runner.runnerId, apiKey: runner.apiKey }, { feature: 'update-ticket' });
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

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('AC-14: a start on a VERIFY_FIX ticket answers invalid_input: status and stores no action', async () => {
    await setTicket({ status: 'VERIFY_FIX' });

    const { content, isError } = resultOf(await callTool('ac14', { ref: 'KODA-1', status: 'IN_PROGRESS' }).expect(200));

    expect({ content, isError }).toEqual({ content: 'invalid_input: status: KODA-1 is VERIFY_FIX; only a CREATED or VERIFIED ticket can be started', isError: true });
    expect(await prisma.assistantActionRequest.count({ where: { jobId: repo.jobId, toolCallId: 'ac14' } })).toBe(0);
    expect(await ticketState()).toMatchObject({ status: 'VERIFY_FIX' });
    // The audit row proves the call reached the registered tool rather than being refused by name.
    expect(await prisma.assistantToolCall.findUniqueOrThrow({ where: { jobId_toolCallId: { jobId: repo.jobId, toolCallId: 'ac14' } } }))
      .toMatchObject({ tool: TOOL, outcome: 'invalid_input', isError: true, content: 'invalid_input: status: KODA-1 is VERIFY_FIX; only a CREATED or VERIFIED ticket can be started' });
  });

  it('AC-15: the approved start and priority change leave the ticket started with the new priority', async () => {
    await setTicket({ status: 'CREATED', priority: 'MEDIUM' });
    const action = await propose('ac15', { ref: 'KODA-1', status: 'IN_PROGRESS', priority: 'HIGH' });
    // The stored preview is the masked field diff the user approves, in the fixed field order.
    expect(action.preview.split('\n')).toEqual([
      'Update KODA-1 "Fix login" in web:',
      'priority: MEDIUM -> HIGH',
      'status: CREATED -> IN_PROGRESS',
    ]);
    // The proposal waits: nothing is written before the user decides.
    expect(await ticketState()).toMatchObject({ status: 'CREATED', priority: 'MEDIUM' });

    await decide(action.id, 'approve').expect(200);

    expect(await ticketState()).toMatchObject({ status: 'IN_PROGRESS', priority: 'HIGH' });
    expect(await findThreadAction(prisma, { requestId: action.id }))
      .toMatchObject({ status: 'executed', result: { text: 'updated KODA-1 /web/tickets/KODA-1' } });
  });

  it('AC-16: a start closed before the approval fails with the move it cannot make', async () => {
    await setTicket({ status: 'CREATED', priority: 'MEDIUM' });
    const action = await propose('ac16', { ref: 'KODA-1', status: 'IN_PROGRESS' });
    await setTicket({ status: 'CLOSED' });

    await decide(action.id, 'approve').expect(200);

    expect(await findThreadAction(prisma, { requestId: action.id }))
      .toMatchObject({ status: 'failed', result: { name: 'ToolActionError' } });
  });

  it('AC-17: the failed start writes no field changes either, so the priority stays what it was', async () => {
    await setTicket({ status: 'CREATED', priority: 'MEDIUM' });
    const action = await propose('ac17', { ref: 'KODA-1', status: 'IN_PROGRESS', priority: 'HIGH' });
    await setTicket({ status: 'CLOSED' });

    await decide(action.id, 'approve').expect(200);

    expect(await ticketState()).toMatchObject({ status: 'CLOSED', priority: 'MEDIUM' });
  });

  it('the proposal\'s preview lists the changed fields, and the approval writes only those fields', async () => {
    await setTicket({ status: 'CREATED', priority: 'MEDIUM', title: 'Fix login' });
    const action = await propose('preview-fields', { ref: 'KODA-1', title: 'Fix the login page', priority: 'LOW' });

    expect(action.preview.split('\n')).toEqual([
      'Update KODA-1 "Fix login" in web:',
      'title: Fix login -> Fix the login page',
      'priority: MEDIUM -> LOW',
    ]);

    await decide(action.id, 'approve').expect(200);

    expect(await ticketState()).toMatchObject({ status: 'CREATED', title: 'Fix the login page', priority: 'LOW' });
  });

  it('a status other than IN_PROGRESS answers invalid_input: status and stores no action', async () => {
    await setTicket({ status: 'CREATED', priority: 'MEDIUM' });

    const { content, isError } = resultOf(await callTool('ac-invalid', { ref: 'KODA-1', status: 'CLOSED' }).expect(200));

    expect({ content, isError }).toEqual({ content: 'invalid_input: status: only IN_PROGRESS is accepted', isError: true });
    expect(await prisma.assistantActionRequest.count({ where: { jobId: repo.jobId, toolCallId: 'ac-invalid' } })).toBe(0);
  });

  it('a ref that matches no ticket of the project answers not_found and stores no action', async () => {
    const { content, isError } = resultOf(await callTool('ac-not-found', { ref: 'KODA-99', title: 'New' }).expect(200));

    expect({ content, isError }).toEqual({ content: 'not_found', isError: true });
    expect(await prisma.assistantActionRequest.count({ where: { jobId: repo.jobId, toolCallId: 'ac-not-found' } })).toBe(0);
  });
});

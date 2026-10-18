/**
 * Fleet S5b 3 (US-004) — the direct action record over PG: one `recordDirect` writes exactly one terminal
 * `PendingAction` with no thread, no requester, no approver and no approval, and the expiry sweeper leaves it alone.
 *
 * Fixtures follow `assistant-actions-decide.integration.spec.ts`: `seedFleetHttpWorld`, agent `claude` from
 * `seedFleetHttpAgent` with an `AgentProject` row for `web`, `FLEET_THREADS_ENABLED=true` before boot. No thread is
 * seeded: 3-D14's whole point is that a direct action has none.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/assistant-direct-action-record.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { AssistantActionService } from '../../../src/fleet/assistant/actions/assistant-action.service';
import { PendingActionExpirySweeper } from '../../../src/fleet/assistant/actions/pending-action-expiry.sweeper';
import type { DirectActionInput } from '../../../src/fleet/assistant/actions/pending-action.domain';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

/** AC-10's clock: a direct action's `expiresAt` is its `now`, so the sweep runs a day past it. */
const DAY_MS = 86_400_000;

describeIntegration('recording a direct assistant action (PG, US-004)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let actions: AssistantActionService;
  let sweeper: PendingActionExpirySweeper;
  /** The agent `claude` of the ACs: a real agent with a real API key, rostered on `web` only. */
  let claude: { id: string; slug: string; apiKey: string };
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of ['FLEET_THREADS_ENABLED', 'FLEET_SWEEP_ENABLED']) saved[key] = process.env[key];
    process.env['FLEET_THREADS_ENABLED'] = 'true';
    process.env['FLEET_SWEEP_ENABLED'] = 'false';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    claude = await seedFleetHttpAgent(app.getHttpServer(), world.tokens.root);
    await prisma.agentProject.create({ data: { projectId: world.projectId, agentId: claude.id } });
    actions = app.get(AssistantActionService, { strict: false });
    sweeper = app.get(PendingActionExpirySweeper, { strict: false });
  }, 120_000);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      for (const key of ['FLEET_THREADS_ENABLED', 'FLEET_SWEEP_ENABLED']) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  const row = (id: string) => prisma.pendingAction.findUniqueOrThrow({ where: { id } });

  /** One `claude` MCP write of `koda_add_comment` in `web`, as the `none` path records it (3-D14). */
  const direct = (over: Partial<DirectActionInput> = {}): DirectActionInput => ({
    projectId: world.projectId, tool: 'koda_add_comment', input: { ref: 'WEB-1', body: 'hello from MCP' },
    preview: 'Add a comment to WEB-1 "Fix login":\n\nhello from MCP', actorType: 'agent', actorId: claude.id,
    origin: 'mcp', status: 'EXECUTED', result: 'done', now: new Date(), ...over,
  });

  /** A real `recordDirect`, answering the id and the exact input it stored so a test can compare the clock. */
  async function record(over: Partial<DirectActionInput> = {}): Promise<{ actionId: string; input: DirectActionInput }> {
    const input = direct(over);
    const { actionId } = await actions.recordDirect(input);
    return { actionId, input };
  }

  it('AC-4: an EXECUTED recordDirect answers an actionId naming a stored EXECUTED row with its result', async () => {
    const { actionId } = await record();

    expect(await row(actionId)).toMatchObject({ id: actionId, status: 'EXECUTED', result: 'done' });
  });

  it("AC-5: that row is claude's MCP write, approved by none", async () => {
    const { actionId } = await record();

    expect(await row(actionId)).toMatchObject({
      actorType: 'agent', actorId: claude.id, origin: 'mcp', approvalMode: 'none',
    });
  });

  it('AC-6: that row has no approver, approval, thread, job, tool-call id or requester', async () => {
    const { actionId } = await record();

    expect(await row(actionId)).toMatchObject({
      approverType: null, approverId: null, approvalId: null, threadId: null, jobId: null, toolCallId: null,
      requestedById: null, decidedById: null,
    });
  });

  it('AC-7: that row is decided and expires at the now it was given', async () => {
    const { actionId, input } = await record();

    const stored = await row(actionId);
    expect(stored.decidedAt).toEqual(input.now);
    expect(stored.expiresAt).toEqual(input.now);
  });

  it('AC-8: no FleetApproval is opened and no approval payload names the new action id', async () => {
    const before = await prisma.fleetApproval.count();

    const { actionId } = await record();

    expect(await prisma.fleetApproval.count()).toBe(before);
    const payloads = await prisma.fleetApproval.findMany({ select: { payload: true } });
    expect(payloads.filter((approval) => JSON.stringify(approval.payload).includes(actionId))).toEqual([]);
  });

  it('AC-9: a FAILED call stores its own status and failure text', async () => {
    const { actionId } = await record({ status: 'FAILED', result: 'not_found' });

    expect(await row(actionId)).toMatchObject({ status: 'FAILED', result: 'not_found' });
  });

  it('AC-10: the expiry sweeper a day after that now leaves the row alone', async () => {
    const { actionId, input } = await record();

    const swept = await sweeper.tick(new Date(input.now.getTime() + DAY_MS));

    expect(swept).toEqual({ expired: 0, failed: 0 });
    expect((await row(actionId)).status).toBe('EXECUTED');
  });
});

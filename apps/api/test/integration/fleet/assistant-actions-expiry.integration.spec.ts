/**
 * Fleet S5b 2a US-007 — the action expiry sweep against PG: a due action the requester never decided becomes
 * EXPIRED with its approval expired, its thread note, and a not-yet-due action untouched; and a job that ends while
 * an action is pending leaves both the action and its approval alone (bash closure stays bash-only).
 *
 * Every action is seeded through a real `AssistantActionService.propose` (spec §Stories) and the job-end regression
 * drives real `JobTransitionsService.apply` calls, so no test writes `FleetJob.state` or a status column directly.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/assistant-actions-expiry.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { FleetJobState } from '../../../src/common/enums';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { AssistantActionService } from '../../../src/fleet/assistant/actions/assistant-action.service';
import { ACTION_TTL_MS, type ProposeInput } from '../../../src/fleet/assistant/actions/pending-action.domain';
import { PendingActionExpirySweeper } from '../../../src/fleet/assistant/actions/pending-action-expiry.sweeper';
import { SYSTEM_ACTOR } from '../../../src/fleet/common/system-actor';
import { FLEET_JOB_REPOSITORY, type FleetJobRecord, type IFleetJobRepository } from '../../../src/fleet/jobs/domain/fleet-job.domain';
import { JobTransitionsService } from '../../../src/fleet/jobs/job-transitions.service';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

const TOOL = 'koda_add_comment';

interface Proposal { actionId: string; approvalId: string; threadId: string; jobId: string }

describeIntegration('expiring an assistant_action (PG, US-007)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let actions: AssistantActionService;
  let sweeper: PendingActionExpirySweeper;
  let transitions: JobTransitionsService;
  let jobs: IFleetJobRepository;
  let tx: ITransactionManager;
  let seq = 0;
  const saved: Record<string, string | undefined> = {};

  const actionRow = (id: string) => prisma.pendingAction.findUniqueOrThrow({ where: { id } });
  const approvalRow = (id: string) => prisma.fleetApproval.findUniqueOrThrow({ where: { id } });
  const systemNotes = (threadId: string) => prisma.chatMessage.findMany({ where: { threadId, role: 'system' }, orderBy: { seq: 'asc' } });

  /** A REPO thread of the web project owned by dev, with the RUNNING THREAD job the action's approval hangs off. */
  async function seedThread(): Promise<{ threadId: string; jobId: string }> {
    const thread = await prisma.chatThread.create({
      data: {
        projectId: world.projectId, kind: 'REPO', repoId: world.repoId, baseRef: 'trunk', feature: `expiry-${++seq}`,
        title: `expiry ${seq}`, createdById: world.ids.dev,
        backend: { kind: 'native', model: 'm1' } as Prisma.InputJsonValue, skills: [],
      },
    });
    const job = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${thread.id}`,
        profiles: [], selectorLabels: [], maxCostUsd: new Prisma.Decimal(5), requestedById: world.ids.dev,
        state: 'RUNNING', threadId: thread.id,
      },
    });
    return { threadId: thread.id, jobId: job.id };
  }

  /**
   * A real propose for a fresh thread. `now` is the propose instant, so passing one more than `ACTION_TTL_MS` ago
   * seeds an action and an approval that are both already past `expiresAt` — the state a real backlog is in.
   */
  async function propose(over: Partial<ProposeInput> = {}): Promise<Proposal> {
    const { threadId, jobId } = await seedThread();
    const result = await actions.propose({
      projectId: world.projectId, threadId, threadKind: 'REPO', threadProjectSlug: 'web', jobId,
      toolCallId: `tc-${++seq}`, tool: TOOL, input: { ref: 'KODA-1', body: 'hello' }, preview: 'Add a comment',
      requestedById: world.ids.dev, now: new Date(), ...over,
    });
    if ('refused' in result) throw new Error('propose refused');
    const row = await prisma.pendingAction.findUniqueOrThrow({ where: { id: result.actionId } });
    return { actionId: result.actionId, approvalId: row.approvalId as string, threadId, jobId };
  }

  /** An action nobody decided yet, whose expiresAt is already past: proposed a full TTL plus a minute ago. */
  const past = (): Date => new Date(Date.now() - ACTION_TTL_MS - 60_000);

  /** One real transition, inside its own transaction, exactly as the sync and sweep paths do it. */
  async function advance(jobId: string, to: FleetJobState): Promise<void> {
    await tx.run(async () => {
      const job = await jobs.findById(jobId);
      if (!job) throw new Error(`job ${jobId} is gone`);
      await transitions.apply({ job: job as FleetJobRecord, to, by: 'runner', now: new Date(), actor: SYSTEM_ACTOR, reason: 'test' });
    });
  }

  /** The runner reports UPLOADING and then COMPLETED; the first step is what closes a RUNNING job's bash asks. */
  async function completeJob(jobId: string): Promise<void> {
    await advance(jobId, 'UPLOADING');
    await advance(jobId, 'COMPLETED');
  }

  beforeAll(async () => {
    // The interval must stay armless: the tests call `tick` themselves, and a background tick would sweep a second time.
    for (const key of ['FLEET_SWEEP_ENABLED', 'FLEET_THREADS_ENABLED'] as const) saved[key] = process.env[key];
    process.env['FLEET_SWEEP_ENABLED'] = 'false';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    actions = app.get(AssistantActionService, { strict: false });
    sweeper = app.get(PendingActionExpirySweeper, { strict: false });
    transitions = app.get(JobTransitionsService);
    jobs = app.get<IFleetJobRepository>(FLEET_JOB_REPOSITORY);
    tx = app.get<ITransactionManager>(TRANSACTION_MANAGER);
  }, 120_000);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      for (const key of ['FLEET_SWEEP_ENABLED', 'FLEET_THREADS_ENABLED'] as const) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  it('AC-1: tick(now) with one due pending action answers { expired: 1, failed: 0 }', async () => {
    await propose({ now: past() });

    expect(await sweeper.tick(new Date())).toEqual({ expired: 1, failed: 0 });
  });

  it('AC-2: after that tick the action is EXPIRED, with a decidedAt and no decidedById', async () => {
    const { actionId } = await propose({ now: past() });

    await sweeper.tick(new Date());

    const action = await actionRow(actionId);
    expect(action.status).toBe('EXPIRED');
    expect(action.decidedById).toBeNull();
    expect(action.decidedAt).not.toBeNull();
  });

  it('AC-3: after that tick the action\'s approval is expired and was resolved by timeout', async () => {
    const { approvalId } = await propose({ now: past() });

    await sweeper.tick(new Date());

    expect(await approvalRow(approvalId)).toMatchObject({ status: 'expired', resolvedBy: 'timeout' });
  });

  it('AC-4: after that tick the thread carries the system note of an expired action', async () => {
    const { actionId, threadId } = await propose({ now: past() });

    await sweeper.tick(new Date());

    const notes = await systemNotes(threadId);
    expect(notes.map((note) => note.content)).toEqual([`Action ${actionId} (${TOOL}) expired without a decision.`]);
    expect(notes[0]).toMatchObject({ role: 'system', status: 'complete', authorUserId: null });
    expect(notes[0].seq).toBeGreaterThan(0);
  });

  it('AC-5: an action whose expiresAt is after now keeps PENDING, and its approval keeps pending', async () => {
    const { actionId, approvalId, threadId } = await propose();

    await sweeper.tick(new Date());

    expect(await actionRow(actionId)).toMatchObject({ status: 'PENDING', decidedAt: null, decidedById: null });
    expect(await approvalRow(approvalId)).toMatchObject({ status: 'pending', resolvedBy: null });
    expect(await systemNotes(threadId)).toHaveLength(0);
  });

  it('AC-8: a pending action survives its job being completed through JobTransitionsService', async () => {
    const { actionId, jobId } = await propose();

    await completeJob(jobId);

    expect(await jobState(jobId)).toBe('COMPLETED');
    expect(await actionRow(actionId)).toMatchObject({ status: 'PENDING', decidedAt: null });
  });

  it('AC-13: that completed job leaves the pending action\'s approval pending too', async () => {
    const { approvalId, jobId } = await propose();

    await completeJob(jobId);

    expect(await approvalRow(approvalId)).toMatchObject({ status: 'pending', resolvedBy: null, decidedAt: null });
  });

  it('a completed job does not stop the sweeper expiring that same, still-pending action', async () => {
    // The job is gone by the time the action is due, which is the normal case: a thread outlives its job.
    const { actionId, approvalId, jobId } = await propose();
    await completeJob(jobId);
    await prisma.pendingAction.update({ where: { id: actionId }, data: { expiresAt: past() } });

    expect(await sweeper.tick(new Date())).toEqual({ expired: 1, failed: 0 });

    expect(await actionRow(actionId)).toMatchObject({ status: 'EXPIRED' });
    expect(await approvalRow(approvalId)).toMatchObject({ status: 'expired', resolvedBy: 'timeout' });
  });

  async function jobState(jobId: string): Promise<string> {
    return (await prisma.fleetJob.findUniqueOrThrow({ where: { id: jobId }, select: { state: true } })).state;
  }
});

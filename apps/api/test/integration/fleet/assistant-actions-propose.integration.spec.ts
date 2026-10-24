/**
 * Fleet S5b 2a US-001 — `AssistantActionService.propose` against PG: the stored action, the approval
 * summary row it opens, the activity row, the outbox event, idempotency and the per-thread cap.
 *
 * Every setup seeds through a real `propose` call (spec §Stories: "DB-backed tests seed a PendingAction
 * through AssistantActionService.propose"), and the cap race holds the thread row from a second
 * connection, so the serialisation AC-14 asserts is real PostgreSQL row locking, not a lucky order.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/assistant-actions-propose.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { AssistantActionService } from '../../../src/fleet/assistant/actions/assistant-action.service';
import { PrismaPendingActionRepository } from '../../../src/fleet/assistant/actions/prisma-pending-action.repository';
import { ACTION_TTL_MS, type ProposeInput } from '../../../src/fleet/assistant/actions/pending-action.domain';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { createTestPrismaClient } from '../../helpers/test-prisma';
import { seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

const NOW = new Date('2026-10-23T09:00:00.000Z');
const TTL_AFTER_NOW = new Date(NOW.getTime() + ACTION_TTL_MS);

interface Seed { threadId: string; jobId: string }

describeIntegration('AssistantActionService.propose (PG, US-001)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let service: AssistantActionService;
  let repo: PrismaPendingActionRepository;
  let seq = 0;

  const slug = 'web';
  const TOOL = 'koda_add_comment';

  /** A thread of `kind` owned by dev, with a RUNNING THREAD job on it (the home project is `web`). */
  async function seedThread(kind: 'REPO' | 'WORKSPACE', projectId = world.projectId): Promise<Seed> {
    const thread = await prisma.chatThread.create({
      data: {
        projectId, kind, repoId: kind === 'REPO' ? world.repoId : null, baseRef: kind === 'REPO' ? 'trunk' : null,
        feature: kind === 'REPO' ? `propose-${++seq}` : null, title: `propose ${seq}`, createdById: world.ids.dev,
        backend: { kind: 'native', model: 'm1' } as Prisma.InputJsonValue, skills: [],
      },
    });
    const job = await prisma.fleetJob.create({
      data: {
        projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${thread.id}`,
        profiles: [], selectorLabels: [], maxCostUsd: new Prisma.Decimal(5), requestedById: world.ids.dev,
        state: 'RUNNING', threadId: thread.id,
      },
    });
    return { threadId: thread.id, jobId: job.id };
  }

  /** One propose call for `seed`; `toolCallId` is fresh unless a test overrides it. */
  const ask = (seed: Seed, over: Partial<ProposeInput> = {}): ProposeInput => ({
    projectId: world.projectId, threadId: seed.threadId, threadKind: 'REPO', threadProjectSlug: slug, jobId: seed.jobId,
    toolCallId: `tc-${++seq}`, tool: TOOL, input: { ref: 'KODA-1', body: 'hello' }, preview: 'Add a comment to KODA-1 "Fix login":\n\nhello',
    actorId: world.ids.dev, now: NOW, ...over,
  });

  /** One propose call for `seed`: the thread tool call the assistant makes for the requester. */
  const call = (seed: Seed, over: Partial<ProposeInput> = {}) =>
    withTestActor({ type: 'SYSTEM', id: 'assistant' }, () => service.propose(ask(seed, over)));

  const actionId = (result: { actionId: string } | { refused: true }): string => {
    if ('refused' in result) throw new Error('propose refused');
    return result.actionId;
  };

  const pendingIn = (threadId: string) => prisma.pendingAction.count({ where: { threadId, status: 'PENDING' } });

  const approvalOf = (id: string | null) => prisma.fleetApproval.findUniqueOrThrow({ where: { id: id as string } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    service = app.get(AssistantActionService, { strict: false });
    repo = app.get(PrismaPendingActionRepository, { strict: false });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('AC-1: propose answers the id of a stored PENDING action', async () => {
    const seed = await seedThread('REPO');

    const result = await call(seed);

    expect(result).not.toHaveProperty('refused');
    const row = await prisma.pendingAction.findUniqueOrThrow({ where: { id: actionId(result) } });
    expect(row).toMatchObject({
      status: 'PENDING', projectId: world.projectId, threadId: seed.threadId, jobId: seed.jobId,
      tool: TOOL, actorType: 'user', actorId: world.ids.dev, approverId: null, decidedAt: null, result: null, deliveredAt: null,
    });
  });

  it('AC-2: the stored action\'s input is the input propose was given', async () => {
    const seed = await seedThread('REPO');
    const input = { ref: 'KODA-42', body: 'a body with "quotes" and\nnewlines', labels: ['x', 'y'], n: 3 };

    const result = await call(seed, { input });

    const row = await prisma.pendingAction.findUniqueOrThrow({ where: { id: actionId(result) } });
    expect(row.input).toEqual(input);
  });

  it('AC-3: the stored action expires exactly ACTION_TTL_MS after the now propose was given', async () => {
    const seed = await seedThread('REPO');

    const result = await call(seed);

    const row = await prisma.pendingAction.findUniqueOrThrow({ where: { id: actionId(result) } });
    expect(row.expiresAt).toEqual(TTL_AFTER_NOW);
  });

  it('AC-4: propose stores one pending assistant_action approval', async () => {
    const seed = await seedThread('REPO');

    const result = await call(seed);

    const row = await prisma.pendingAction.findUniqueOrThrow({ where: { id: actionId(result) } });
    const approval = await approvalOf(row.approvalId);
    expect(approval).toMatchObject({
      type: 'assistant_action', status: 'pending', projectId: world.projectId, jobId: seed.jobId,
      policyId: null, requestedAt: NOW, decidedById: null, decidedAt: null,
    });
    expect(await prisma.fleetApproval.count({ where: { jobId: seed.jobId } })).toBe(1);
  });

  it('AC-5: the approval payload is the five-key summary and nothing else', async () => {
    const seed = await seedThread('REPO');

    const result = await call(seed);
    const id = actionId(result);

    const approval = await approvalOf((await prisma.pendingAction.findUniqueOrThrow({ where: { id } })).approvalId);
    expect(approval.payload).toEqual({
      actionId: id, tool: TOOL, threadId: seed.threadId, threadPath: `/${slug}/threads/${seed.threadId}`, requestedById: world.ids.dev,
    });
    expect(Object.keys(approval.payload).sort()).toEqual(['actionId', 'requestedById', 'threadId', 'threadPath', 'tool']);
    // The preview and the input never reach the approval summary (2a-D5).
    expect(JSON.stringify(approval.payload)).not.toContain('hello');
  });

  it('AC-6: the approval expires with the action', async () => {
    const seed = await seedThread('REPO');

    const result = await call(seed);

    const row = await prisma.pendingAction.findUniqueOrThrow({ where: { id: actionId(result) } });
    expect((await approvalOf(row.approvalId)).expiresAt).toEqual(row.expiresAt);
  });

  it('AC-7: the action names the approval propose opened for it', async () => {
    const seed = await seedThread('REPO');

    const result = await call(seed);
    const id = actionId(result);

    const row = await prisma.pendingAction.findUniqueOrThrow({ where: { id } });
    const approval = await approvalOf(row.approvalId);
    expect(row.approvalId).not.toBeNull();
    expect(approval.payload).toMatchObject({ actionId: id });
  });

  it('AC-8: a REPO thread of project web carries the project prefix in threadPath', async () => {
    const seed = await seedThread('REPO');

    const result = await call(seed);

    const row = await prisma.pendingAction.findUniqueOrThrow({ where: { id: actionId(result) } });
    const approval = await approvalOf(row.approvalId);
    expect(approval.payload).toMatchObject({ threadPath: `/web/threads/${seed.threadId}` });
    expect(world.projectId).toBe(row.projectId);
  });

  it('AC-9: a WORKSPACE thread carries no project prefix, whatever project it acts in', async () => {
    const seed = await seedThread('WORKSPACE');

    const result = await call(seed, { projectId: world.opsProjectId, threadKind: 'WORKSPACE', threadProjectSlug: slug });

    const row = await prisma.pendingAction.findUniqueOrThrow({ where: { id: actionId(result) } });
    expect((await approvalOf(row.approvalId)).payload).toMatchObject({ threadPath: `/threads/${seed.threadId}` });
  });

  it('AC-10/AC-11: a repeated (jobId, toolCallId) answers the same action and stores no second one', async () => {
    const seed = await seedThread('REPO');
    const toolCallId = `tc-${++seq}`;

    const first = await call(seed, { toolCallId });
    const again = await call(seed, { toolCallId });

    expect(again).toEqual({ actionId: actionId(first) });
    expect(await prisma.pendingAction.count({ where: { threadId: seed.threadId } })).toBe(1);
    expect(await prisma.fleetApproval.count({ where: { jobId: seed.jobId } })).toBe(1);
    expect(await pendingIn(seed.threadId)).toBe(1);
  });

  it('AC-12/AC-13: at 10 pending actions a fresh call is refused and nothing is written', async () => {
    const seed = await seedThread('REPO');
    for (let i = 0; i < 10; i++) await call(seed);
    expect(await pendingIn(seed.threadId)).toBe(10);

    const refused = await call(seed);

    expect(refused).toEqual({ refused: true });
    expect(await pendingIn(seed.threadId)).toBe(10);
    expect(await prisma.pendingAction.count({ where: { threadId: seed.threadId } })).toBe(10);
    expect(await prisma.fleetApproval.count({ where: { jobId: seed.jobId } })).toBe(10);
  });

  it('AC-14: with 9 pending, two concurrent calls leave the thread at exactly 10', async () => {
    const seed = await seedThread('REPO');
    for (let i = 0; i < 9; i++) await call(seed);
    expect(await pendingIn(seed.threadId)).toBe(9);

    // Hold the thread row from another connection: both calls must block in step 1 until we release it,
    // which is why the count the second one reads is the first one's 10 and not the stale 9.
    const holder = createTestPrismaClient();
    let locked!: () => void;
    let release!: () => void;
    const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holding = holder.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ChatThread" WHERE "id" = ${seed.threadId} FOR UPDATE`;
      locked();
      await gate;
    });
    let firstSettled = false;
    let secondSettled = false;
    try {
      await lockTaken;
      const first = call(seed).then((result) => { firstSettled = true; return result; });
      const second = call(seed).then((result) => { secondSettled = true; return result; });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect([firstSettled, secondSettled]).toEqual([false, false]);

      release();
      await holding;
      const results = await Promise.all([first, second]);

      expect(results.filter((result) => 'actionId' in result)).toHaveLength(1);
      expect(results.filter((result) => 'refused' in result)).toEqual([{ refused: true }]);
      expect(await pendingIn(seed.threadId)).toBe(10);
    } finally {
      release();
      await holding.catch(() => undefined);
      await holder.$disconnect();
    }
  });

  it('AC-16/AC-17: the approval.requested activity names the requester and the thread', async () => {
    const seed = await seedThread('REPO');

    const result = await call(seed);

    const row = await prisma.pendingAction.findUniqueOrThrow({ where: { id: actionId(result) } });
    const activity = await prisma.fleetActivity.findMany({
      where: { entityType: 'approval', entityId: row.approvalId as string, action: 'approval.requested' },
    });
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ actorType: 'USER', actorId: world.ids.dev, jobId: seed.jobId, projectId: world.projectId });
    expect(activity[0].payload).toMatchObject({ threadId: seed.threadId });
  });

  it('AC-18: propose enqueues one fleet_approval_requested row naming the requester', async () => {
    const seed = await seedThread('REPO');

    const result = await call(seed);

    const row = await prisma.pendingAction.findUniqueOrThrow({ where: { id: actionId(result) } });
    const events = await prisma.outboxEvent.findMany({ where: { type: 'fleet_approval_requested', eventId: row.approvalId as string } });
    expect(events).toHaveLength(1);
    expect(events[0].projectId).toBe(world.projectId);
    expect(JSON.parse(events[0].payload)).toMatchObject({
      approvalId: row.approvalId, type: 'assistant_action', projectId: world.projectId, jobId: seed.jobId,
      requestedById: world.ids.dev, threadPath: `/web/threads/${seed.threadId}`, tool: TOOL,
    });
  });

  it('the repository answers the slug of the project the action acts in, not the thread\'s home project', async () => {
    const seed = await seedThread('WORKSPACE');
    const toolCallId = `tc-${++seq}`;

    const result = await call(seed, { projectId: world.opsProjectId, threadKind: 'WORKSPACE', toolCallId });
    const id = actionId(result);

    const found = await repo.findByCall(seed.jobId, toolCallId);
    expect(found).toMatchObject({ id, projectId: world.opsProjectId, projectSlug: 'ops' });
    expect(await repo.findById(id)).toMatchObject({ projectSlug: 'ops' });
    expect(await repo.countPending(seed.threadId)).toBe(1);
  });
});

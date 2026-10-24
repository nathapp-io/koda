import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { putThreadLines, seedThreadJobFor, ThreadJobSeed } from '../../helpers/thread-fixtures';
import { BudgetEvaluator } from '../../../src/fleet/budgets/budget-evaluator';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
const ENV = ['FLEET_ARTIFACT_DIR', 'FLEET_THREADS_ENABLED'] as const;

describeIntegration('fleet thread cost folding and spend (PG, US-005)', () => {
  let app: NathApplication;
  let artifactDir: string | undefined;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  let n = 0;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of ENV) saved[key] = process.env[key];
    process.env.FLEET_THREADS_ENABLED = 'true';
    artifactDir = mkdtempSync(join(tmpdir(), 'koda-thread-cost-'));
    process.env.FLEET_ARTIFACT_DIR = artifactDir;
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'cost-runner');
    await prisma.runner.update({ where: { id: runner.runnerId }, data: { protocolVersion: 4, lastSeenAt: new Date(), enabled: true, capacity: 5 } });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      for (const key of ENV) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      if (artifactDir) rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  const fresh = (name: string): Promise<ThreadJobSeed> =>
    seedThreadJobFor(prisma, world, runner, { feature: `${name}-${++n}` });
  const put = (seed: ThreadJobSeed, lines: object[], offset = 0) =>
    putThreadLines(server, seed.runnerKey, { id: seed.jobId }, lines.map((line) => JSON.stringify(line)), offset);
  const usage = (over: Record<string, unknown> = {}) => ({
    type: 'usage', turnId: 't1', round: 1, inputTokens: 100, outputTokens: 20, cacheRead: 5, costUsd: 0.0123, ...over,
  });
  const start = () => ({ type: 'turn_start', turnId: 't1' });
  const turnEnd = (over: Record<string, unknown> = {}) => ({
    type: 'turn_end', turnId: 't1', status: 'completed', output: 'Final',
    usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0, ...over,
  });
  const thread = (seed: ThreadJobSeed) => prisma.chatThread.findUniqueOrThrow({ where: { id: seed.threadId } });
  const job = (seed: ThreadJobSeed) => prisma.fleetJob.findUniqueOrThrow({ where: { id: seed.jobId } });
  const message = (seed: ThreadJobSeed) => prisma.chatMessage.findFirstOrThrow({
    where: { threadId: seed.threadId, turnId: 't1', role: 'assistant' },
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('rederives multiple touched turns with exact rounding and literal turn-id matching', async () => {
    const s = await fresh('multi-turn-cost');
    await put(s, [
      { type: 'turn_start', turnId: 't1' },
      usage({ turnId: 't1', round: 1, costUsd: 0.00004 }),
      usage({ turnId: 't1', round: 2, costUsd: 0.00004 }),
      { type: 'turn_start', turnId: 't1:child' },
      usage({ turnId: 't1:child', costUsd: 0.02 }),
      { type: 'turn_start', turnId: 't_%' },
      usage({ turnId: 't_%', costUsd: 0.00005 }),
    ]);
    const messages = await prisma.chatMessage.findMany({
      where: { threadId: s.threadId, role: 'assistant' }, orderBy: { seq: 'asc' },
    });
    expect(messages.map((m) => [m.turnId, m.costUsd?.toString()])).toEqual([
      ['t1', '0.0001'], ['t1:child', '0.02'], ['t_%', '0.0001'],
    ]);
    expect((await thread(s)).costUsd.toString()).toBe('0.0201');
    expect((await job(s)).costSpentUsd.toString()).toBe('0.0201');
  });

  it('US-005 AC1: folds priced usage into assistant message cost, source and token usage', async () => {
    const s = await fresh('cost-message');
    await put(s, [start(), usage()]);
    const stored = await message(s);
    expect(stored.costUsd?.toString()).toBe('0.0123');
    expect(stored).toMatchObject({ costSource: 'computed', usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0 } });
  });

  it('US-005 AC2: adds priced usage to thread cost and tokens', async () => {
    const s = await fresh('cost-thread');
    await put(s, [start(), usage()]);
    const stored = await thread(s);
    expect(stored.costUsd.toString()).toBe('0.0123');
    expect(stored.tokens).toEqual({ input: 100, output: 20, cacheRead: 5, cacheWrite: 0 });
  });

  it('US-005 AC3: adds priced usage to job cost', async () => {
    const s = await fresh('cost-job');
    await put(s, [start(), usage()]);
    expect((await job(s)).costSpentUsd.toString()).toBe('0.0123');
  });

  it('US-005 AC4: creates a priced native thread FleetCostEvent', async () => {
    const s = await fresh('cost-event');
    await put(s, [start(), usage()]);
    expect(await prisma.fleetCostEvent.findMany({ where: { jobId: s.jobId } })).toEqual([
      expect.objectContaining({ jobId: s.jobId, leaseEpoch: 1, projectId: world.projectId, repoId: world.repoId, runnerId: runner.runnerId, callId: 't1:1', stage: 'thread', agentName: 'native', model: 'm1', profile: 'read', featureName: s.feature, inputTokens: 100, costUsd: new Prisma.Decimal('0.0123'), pricingSource: 'computed' }),
    ]);
  });

  it('US-005 AC5: rounds sums once after ten tiny usage events', async () => {
    const s = await fresh('cost-round');
    await put(s, [start(), ...Array.from({ length: 10 }, (_, index) => usage({ round: index + 1, costUsd: 0.00004 }))]);
    expect((await job(s)).costSpentUsd.toString()).toBe('0.0004');
    expect((await thread(s)).costUsd.toString()).toBe('0.0004');
  });

  it('US-005 AC6: unpriced usage adds tokens but no cost event or spend', async () => {
    const s = await fresh('cost-unpriced');
    await put(s, [start(), usage({ costSource: 'unpriced', costUsd: 0, inputTokens: 50, outputTokens: 0, cacheRead: 0 })]);
    expect((await thread(s)).tokens).toEqual({ input: 50, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect((await thread(s)).costUsd.toString()).toBe('0');
    expect(await prisma.fleetCostEvent.count({ where: { jobId: s.jobId } })).toBe(0);
  });

  it('US-005 AC7: reconciles positive turn_end cost as a separate cost event', async () => {
    const s = await fresh('cost-reconcile');
    await put(s, [start(), usage({ round: 1, costUsd: 0.01 }), usage({ round: 2, costUsd: 0.02 }), turnEnd({ costUsd: 0.05 })]);
    expect((await thread(s)).costUsd.toString()).toBe('0.05');
    expect(await prisma.fleetCostEvent.findUnique({ where: { jobId_leaseEpoch_callId: { jobId: s.jobId, leaseEpoch: 1, callId: 't1:turn_end' } } })).toMatchObject({ costUsd: new Prisma.Decimal('0.02') });
  });

  it('US-005 AC8: does not add a reconcile event when turn_end cost equals usage cost', async () => {
    const s = await fresh('cost-no-reconcile');
    await put(s, [start(), usage({ round: 1, costUsd: 0.01 }), usage({ round: 2, costUsd: 0.02 }), turnEnd({ costUsd: 0.03 })]);
    expect(await prisma.fleetCostEvent.count({ where: { jobId: s.jobId, callId: 't1:turn_end' } })).toBe(0);
    expect((await thread(s)).costUsd.toString()).toBe('0.03');
  });

  it('US-005 AC9: reconciles turn_end token totals into both message and thread', async () => {
    const s = await fresh('cost-token-reconcile');
    await put(s, [start(), usage({ round: 1, inputTokens: 100 }), usage({ round: 2, inputTokens: 100 }), turnEnd({ usage: { inputTokens: 300, outputTokens: 20 } })]);
    expect((await message(s)).usage).toMatchObject({ input: 300 });
    expect((await thread(s)).tokens).toMatchObject({ input: 300 });
  });

  it('US-005 AC10: duplicate priced usage is idempotent and does not count as skipped', async () => {
    const s = await fresh('cost-duplicate');
    await put(s, [start(), usage(), usage()]);
    expect(await prisma.fleetCostEvent.count({ where: { jobId: s.jobId, callId: 't1:1' } })).toBe(1);
    expect((await thread(s)).costUsd.toString()).toBe('0.0123');
    expect((await thread(s)).tokens).toMatchObject({ input: 100 });
    expect((await prisma.threadIngestCursor.findUniqueOrThrow({ where: { jobId_leaseEpoch: { jobId: s.jobId, leaseEpoch: 1 } } })).skippedLines).toBe(0);
  });

  it('US-005 AC11: signals all spend scopes after priced usage changes cost', async () => {
    const s = await fresh('cost-budget-signal');
    const signal = vi.spyOn(app.get(BudgetEvaluator), 'signal');
    await put(s, [start(), usage()]);
    expect(signal).toHaveBeenCalledWith(expect.arrayContaining(['global', `project:${world.projectId}`, `repo:${world.repoId}`, `runner:${runner.runnerId}`]));
    signal.mockRestore();
  });

  it('US-005 AC12: does not signal budgets for a cost-free batch', async () => {
    const s = await fresh('cost-no-signal');
    const signal = vi.spyOn(app.get(BudgetEvaluator), 'signal');
    await put(s, [start(), { type: 'text_delta', turnId: 't1', round: 1, text: 'hello' }]);
    expect(signal).not.toHaveBeenCalled();
    signal.mockRestore();
  });

  it('US-005 AC13: project hard stop cancels queued THREAD and requests cancellation of held THREAD', async () => {
    const s = await fresh('cost-hard-stop');
    const queuedThread = await prisma.chatThread.create({ data: {
      projectId: world.projectId, repoId: world.repoId, baseRef: 'trunk', feature: `queued-${++n}`, title: 'Queued',
      createdById: world.ids.dev, runnerId: runner.runnerId, backend: { kind: 'native', model: 'm1' }, skills: [], specPath: '.nax/features/queued/spec.md',
    } });
    const queued = await prisma.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${queuedThread.id}`,
      profiles: [], selectorLabels: [], maxCostUsd: 5, requestedById: world.ids.dev, state: 'QUEUED', threadId: queuedThread.id,
    } });
    const policy = await prisma.budgetPolicy.create({ data: {
      scopeType: 'project', scopeId: world.projectId, scopeKey: `project:${world.projectId}`, projectId: world.projectId,
      windowKind: 'lifetime', amountUsd: new Prisma.Decimal('0.01'), hardStop: true, runningJobs: 'cancel',
      createdById: world.ids.root, updatedById: world.ids.dev,
    } });
    await put(s, [start(), usage({ costUsd: 0.02 })]);
    // The evaluator's entry is the budget sweeper, the `budget` system component.
    await withTestActor({ type: 'SYSTEM', id: 'budget' }, () => app.get(BudgetEvaluator).evaluate(policy.id, new Date()));
    expect(await prisma.fleetJob.findUniqueOrThrow({ where: { id: queued.id } })).toMatchObject({ state: 'CANCELLED', stateReason: `budget:${policy.id}` });
    expect(await prisma.fleetJob.findUniqueOrThrow({ where: { id: s.jobId } })).toMatchObject({ state: 'RUNNING', cancelRequestedAt: expect.any(Date) });
    expect(await prisma.fleetCommand.count({ where: { jobId: s.jobId, type: 'CANCEL' } })).toBe(1);
  });

  it('US-005 AC14: spend analytics includes a thread cost event', async () => {
    const s = await fresh('cost-analytics');
    const authorization = `Bearer ${world.tokens.dev}`;
    const before = await request(server).get('/api/projects/web/fleet/analytics/spend').set('Authorization', authorization).expect(200);
    await put(s, [start(), usage()]);
    const response = await request(server).get('/api/projects/web/fleet/analytics/spend')
      .set('Authorization', authorization).expect(200);
    expect(new Prisma.Decimal(response.body.data.totals.costUsd).sub(before.body.data.totals.costUsd).toString()).toBe('0.0123');
  });
});

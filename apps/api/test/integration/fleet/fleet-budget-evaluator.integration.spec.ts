/**
 * Fleet S1b slice 2a — BudgetEvaluator on PG: warn once, hard stop, cancel set, webhooks, concurrency, the sync signal.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-budget-evaluator.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { BudgetEvaluator } from '../../../src/fleet/budgets/budget-evaluator';
import { JobReportProcessor } from '../../../src/fleet/sync/job-report.processor';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(20_000);

describeIntegration('budget evaluator (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let evaluator: BudgetEvaluator;
  let reports: JobReportProcessor;
  let n = 0;
  const now = () => new Date();
  const monthStart = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

  const projectPolicy = (over: Partial<Prisma.BudgetPolicyUncheckedCreateInput> = {}) => prisma.budgetPolicy.create({
    data: {
      scopeType: 'project', scopeId: world.projectId, scopeKey: `project:${world.projectId}`, projectId: world.projectId,
      windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(10), warnPercent: 50,
      createdById: world.ids.root, updatedById: world.ids.dev, ...over,
    },
  });
  const job = (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `ev${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.dev, state: 'COMPLETED', firstStartedAt: new Date(), ...over,
    },
  });
  const incidents = (policyId: string, kind: string) => prisma.budgetIncident.count({ where: { policyId, kind } });
  const hooks = (event: string) => prisma.outboxEvent.count({ where: { type: 'webhook_delivery', payload: { contains: `"event":"${event}"` } } });
  const reload = (id: string) => prisma.fleetJob.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    evaluator = app.get(BudgetEvaluator);
    reports = app.get(JobReportProcessor);
    await prisma.webhook.create({
      data: { projectId: world.projectId, url: 'https://hooks.example.com/koda', secret: 's'.repeat(32), events: JSON.stringify(['fleet.budget.warn', 'fleet.budget.hard_stop']) },
    });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.budgetPolicy.deleteMany();
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.outboxEvent.deleteMany();
    await prisma.fleetActivity.deleteMany();
  });

  it('warns once per window and amount, with one webhook and one activity row', async () => {
    const policy = await projectPolicy();
    await job({ costSpentUsd: 6 });
    expect(await evaluator.evaluate(policy.id)).toEqual({ warned: true, stopped: false });
    expect(await evaluator.evaluate(policy.id)).toEqual({ warned: false, stopped: false });
    expect(await incidents(policy.id, 'warn')).toBe(1);
    expect(await hooks('fleet.budget.warn')).toBe(1);
    expect(await prisma.fleetActivity.count({ where: { entityType: 'budget', entityId: policy.id, action: 'budget.warn' } })).toBe(1);
  });

  it('hard stop under finish: pauses, cancels QUEUED in scope, leaves RUNNING alone', async () => {
    const policy = await projectPolicy();
    const runner = await insertRunner(prisma);
    await job({ costSpentUsd: 10 });
    const queued = await job({ state: 'QUEUED', firstStartedAt: null });
    const running = await job({ state: 'RUNNING', runnerId: runner.id, leaseEpoch: 1 });
    expect(await evaluator.evaluate(policy.id)).toEqual({ warned: true, stopped: true });
    const after = await prisma.budgetPolicy.findUniqueOrThrow({ where: { id: policy.id } });
    expect(after.pausedAt).not.toBeNull();
    expect(after.pausedWindowStart).toEqual(monthStart(now()));
    expect(await reload(queued.id)).toEqual(expect.objectContaining({ state: 'CANCELLED', stateReason: `budget:${policy.id}` }));
    expect(await reload(running.id)).toEqual(expect.objectContaining({ state: 'RUNNING', cancelRequestedAt: null }));
    expect(await prisma.fleetCommand.count({ where: { jobId: running.id, type: 'CANCEL' } })).toBe(0);
    expect(await incidents(policy.id, 'hard_stop')).toBe(1);
    expect(await hooks('fleet.budget.hard_stop')).toBe(1);
    const row = await prisma.fleetActivity.findFirstOrThrow({ where: { entityId: policy.id, action: 'budget.hard_stop' } });
    expect(row).toEqual(expect.objectContaining({ actorType: 'SYSTEM', projectId: world.projectId, responsibleUserId: world.ids.dev }));
    expect(row.payload).toEqual(expect.objectContaining({ cancelledJobIds: [queued.id], cancelRequestedJobIds: [] }));
    // Already paused: no second stop.
    expect(await evaluator.evaluate(policy.id)).toEqual({ warned: false, stopped: false });
  });

  it('hard stop under cancel: the runner\'s CANCELLED report ends the job with the budget reason', async () => {
    const policy = await projectPolicy({ runningJobs: 'cancel' });
    const runner = await insertRunner(prisma);
    const running = await job({ state: 'RUNNING', runnerId: runner.id, leaseEpoch: 1, costSpentUsd: 11 });
    await evaluator.evaluate(policy.id);
    expect(await prisma.fleetCommand.count({ where: { jobId: running.id, type: 'CANCEL', ackedAt: null } })).toBe(1);
    await reports.process(runner.id, { jobId: running.id, leaseEpoch: 1, events: [{ seq: 1, type: 'state', payload: { to: 'CANCELLED', reason: null } }] }, new Date());
    expect(await reload(running.id)).toEqual(expect.objectContaining({ state: 'CANCELLED', stateReason: `budget:${policy.id}` }));
  });

  it('stops again in the same month after the amount was raised (incident per amount)', async () => {
    const policy = await projectPolicy({ warnPercent: null });
    await job({ costSpentUsd: 10 });
    await evaluator.evaluate(policy.id);
    await prisma.budgetPolicy.update({ where: { id: policy.id }, data: { amountUsd: new Prisma.Decimal(15), pausedAt: null, pausedWindowStart: null } });
    await job({ costSpentUsd: 5 });
    expect((await evaluator.evaluate(policy.id)).stopped).toBe(true);
    expect(await incidents(policy.id, 'hard_stop')).toBe(2);
    expect(await hooks('fleet.budget.hard_stop')).toBe(2);
  });

  it('sends no webhook for a global policy, and ignores a policy whose runner is gone', async () => {
    const global = await prisma.budgetPolicy.create({
      data: { scopeType: 'global', scopeKey: 'global', windowKind: 'lifetime', amountUsd: new Prisma.Decimal(1), createdById: world.ids.root, updatedById: world.ids.root },
    });
    await job({ costSpentUsd: 2 });
    expect((await evaluator.evaluate(global.id)).stopped).toBe(true);
    expect(await hooks('fleet.budget.hard_stop')).toBe(0);
    const orphan = await prisma.budgetPolicy.create({
      data: { scopeType: 'runner', scopeId: 'gone', scopeKey: 'runner:gone', windowKind: 'lifetime', amountUsd: new Prisma.Decimal(0.0001), createdById: world.ids.root, updatedById: world.ids.root },
    });
    expect(await evaluator.evaluate(orphan.id)).toEqual({ warned: false, stopped: false });
    expect((await prisma.budgetPolicy.findUniqueOrThrow({ where: { id: orphan.id } })).pausedAt).toBeNull();
  });

  it('two concurrent evaluations stop once (review focus 3)', async () => {
    // Five rounds: one race can pass by luck without the policy row lock; five almost never do.
    for (let round = 0; round < 5; round += 1) {
      await prisma.budgetPolicy.deleteMany();
      await prisma.fleetJob.deleteMany();
      await prisma.outboxEvent.deleteMany();
      const policy = await projectPolicy();
      await job({ costSpentUsd: 10 });
      const queued = await job({ state: 'QUEUED', firstStartedAt: null });
      const results = await Promise.all([evaluator.evaluate(policy.id), evaluator.evaluate(policy.id)]);
      expect(results.filter((r) => r.stopped)).toHaveLength(1);
      expect(await incidents(policy.id, 'hard_stop')).toBe(1);
      expect(await hooks('fleet.budget.hard_stop')).toBe(1);
      expect(await prisma.fleetActivity.count({ where: { jobId: queued.id, action: 'job.cancelled' } })).toBe(1);
    }
  });

  it('warns again in the same window after the amount was raised (S1b §2.5)', async () => {
    const policy = await projectPolicy({ hardStop: false });
    await job({ costSpentUsd: 6 });
    expect((await evaluator.evaluate(policy.id)).warned).toBe(true);
    await prisma.budgetPolicy.update({ where: { id: policy.id }, data: { amountUsd: new Prisma.Decimal(20) } });
    await job({ costSpentUsd: 5 });
    expect((await evaluator.evaluate(policy.id)).warned).toBe(true);
    expect(await incidents(policy.id, 'warn')).toBe(2);
    expect(await hooks('fleet.budget.warn')).toBe(2);
  });

  it('signals the job\'s scope keys after a sync that changed its cost, and only then', async () => {
    const runner = await insertRunner(prisma);
    const running = await job({ state: 'RUNNING', runnerId: runner.id, leaseEpoch: 1 });
    const signal = jest.spyOn(evaluator, 'signal').mockImplementation(() => undefined);
    try {
      const snapshot = (seq: number, costSpentUsd: string) =>
        reports.process(runner.id, { jobId: running.id, leaseEpoch: 1, events: [{ seq, type: 'snapshot', payload: { costSpentUsd } }] }, new Date());
      await snapshot(1, '0.5');
      expect(signal).toHaveBeenCalledWith(['global', `project:${world.projectId}`, `repo:${world.repoId}`, `runner:${runner.id}`]);
      signal.mockClear();
      await snapshot(2, '0.5');
      expect(signal).not.toHaveBeenCalled();
    } finally {
      signal.mockRestore();
    }
  });
});

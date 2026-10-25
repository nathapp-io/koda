import type { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, type PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { BudgetEvaluator } from '../../../src/fleet/budgets/budget-evaluator';
import { BudgetSweeper } from '../../../src/fleet/budgets/budget-sweeper';
import { canRunDbTests } from '../../helpers/test-environment';
import { bootHttpApp } from '../../helpers/http-app';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { insertRunner, seedFleetBase } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';

const describeDb = canRunDbTests() ? describe : describe.skip;
const KEY = 'system.budget.window-reset';
const NOW = new Date('2026-11-03T00:00:00.000Z');
const OCTOBER = new Date('2026-10-01T00:00:00.000Z');
const NOVEMBER = new Date('2026-11-01T00:00:00.000Z');

describeDb('fleet system budget audit (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let evaluator: BudgetEvaluator;
  let sweeper: BudgetSweeper;
  let base: Awaited<ReturnType<typeof seedFleetBase>>;
  let sequence = 0;

  const projectPolicy = (over: Partial<Prisma.BudgetPolicyUncheckedCreateInput> = {}) => db.budgetPolicy.create({
    data: {
      scopeType: 'project', scopeId: base.projectId, scopeKey: `project:${base.projectId}`, projectId: base.projectId,
      windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(10), createdById: base.adminId, updatedById: base.adminId, ...over,
    },
  });
  const spend = (amount: number, startedAt = NOW) => db.fleetJob.create({
    data: {
      projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature: `audit-budget-${++sequence}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(10), selectorLabels: [], requestedById: base.adminId, state: 'COMPLETED',
      costSpentUsd: new Prisma.Decimal(amount), firstStartedAt: startedAt,
    },
  });
  const queued = () => db.fleetJob.create({
    data: {
      projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature: `audit-budget-${++sequence}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(10), selectorLabels: [], requestedById: base.adminId, state: 'QUEUED',
    },
  });
  const rows = (resourceId: string) => db.auditEntry.findMany({ where: { key: KEY, resourceId }, orderBy: { createdAt: 'asc' } });
  const evaluate = (id: string) => evaluator.evaluate(id, NOW);

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    db = fixtureDb(app);
    base = await seedFleetBase(db);
    evaluator = app.get(BudgetEvaluator);
    sweeper = app.get(BudgetSweeper);
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    await db.fleetApproval.deleteMany();
    await db.budgetIncident.deleteMany();
    await db.budgetPolicy.deleteMany();
    await db.fleetJob.deleteMany();
    await db.auditEntry.deleteMany();
  });
  afterEach(() => vi.restoreAllMocks());

  it('AC-1 and AC-11: audits orphan deletion as budget; rejection preserves the orphan', async () => {
    const orphanRun = async () => {
      const runner = await insertRunner(db);
      const policy = await db.budgetPolicy.create({ data: {
        scopeType: 'runner', scopeId: runner.id, scopeKey: `runner:${runner.id}`, windowKind: 'lifetime',
        amountUsd: new Prisma.Decimal(10), createdById: base.adminId, updatedById: base.adminId,
      } });
      await db.runner.delete({ where: { id: runner.id } });
      return { policy, result: await sweeper.tick(NOW) };
    };
    const { policy, result } = await orphanRun();
    expect(result).toEqual(expect.objectContaining({ deleted: 1, failed: 0 }));
    expect(await rows(policy.id)).toEqual([expect.objectContaining({ resourceType: 'fleet-budget', projectId: null, actorType: 'SYSTEM', actorId: 'budget', origin: 'system', summary: 'deleted: scope gone' })]);

    const runner = await insertRunner(db);
    const kept = await db.budgetPolicy.create({ data: {
      scopeType: 'runner', scopeId: runner.id, scopeKey: `runner:${runner.id}`, windowKind: 'lifetime',
      amountUsd: new Prisma.Decimal(10), createdById: base.adminId, updatedById: base.adminId,
    } });
    await db.runner.delete({ where: { id: runner.id } });
    vi.spyOn(app.get(AuditRecorder), 'record').mockImplementation(async (input) => {
      if (input.key === KEY) throw new Error('audit unavailable');
    });
    expect(await sweeper.tick(NOW)).toEqual(expect.objectContaining({ failed: 1, deleted: 0 }));
    expect(await db.budgetPolicy.findUnique({ where: { id: kept.id } })).not.toBeNull();
  });

  it('AC-2: audits a monthly window reset', async () => {
    const policy = await projectPolicy({ pausedAt: new Date('2026-10-20T00:00:00.000Z'), pausedWindowStart: OCTOBER });
    await sweeper.tick(NOW);
    expect(await rows(policy.id)).toEqual([expect.objectContaining({ key: KEY, projectId: base.projectId, summary: 'window reset' })]);
    expect(await db.budgetPolicy.findUniqueOrThrow({ where: { id: policy.id } })).toEqual(expect.objectContaining({ pausedAt: null, pausedWindowStart: null }));
    expect(await db.budgetIncident.findFirstOrThrow({ where: { policyId: policy.id, kind: 'window_reset' } })).toEqual(expect.objectContaining({ windowStart: NOVEMBER }));
  });

  it('AC-3: creates no entry when no incident or hard stop is reached', async () => {
    const policy = await projectPolicy({ amountUsd: new Prisma.Decimal(10), warnPercent: 50 });
    await spend(4);
    await withTestActor({ type: 'SYSTEM', id: 'budget' }, () => evaluate(policy.id));
    expect(await rows(policy.id)).toHaveLength(0);
  });

  it('AC-4 and AC-5: records one warn incident on the first evaluation only', async () => {
    const policy = await projectPolicy({ amountUsd: new Prisma.Decimal(10), warnPercent: 50, hardStop: false });
    await spend(6);
    await withTestActor({ type: 'SYSTEM', id: 'budget' }, () => evaluate(policy.id));
    expect(await rows(policy.id)).toEqual([expect.objectContaining({ summary: 'warn incident', actorType: 'SYSTEM', actorId: 'budget' })]);
    await withTestActor({ type: 'SYSTEM', id: 'budget' }, () => evaluate(policy.id));
    expect(await rows(policy.id)).toHaveLength(1);
  });

  it('AC-6, AC-7 and AC-8: audits hard stop counts once without a nested job entry', async () => {
    const policy = await projectPolicy({ amountUsd: new Prisma.Decimal(5), warnPercent: null, hardStop: true });
    await spend(6);
    const queuedJob = await queued();
    await withTestActor({ type: 'SYSTEM', id: 'budget' }, () => evaluate(policy.id));
    expect(await db.fleetJob.findUniqueOrThrow({ where: { id: queuedJob.id } })).toEqual(expect.objectContaining({ state: 'CANCELLED' }));
    expect(await rows(policy.id)).toEqual([expect.objectContaining({ summary: 'hard stop: 1 cancelled, 0 cancel requested' })]);
    expect(await rows(queuedJob.id)).toHaveLength(0);
    await withTestActor({ type: 'SYSTEM', id: 'budget' }, () => evaluate(policy.id));
    expect(await rows(policy.id)).toHaveLength(1);
  });

  it('AC-9: attributes a hard stop to SYSTEM/budget even from a runner context', async () => {
    const policy = await projectPolicy({ amountUsd: new Prisma.Decimal(5), warnPercent: null, hardStop: true });
    const runner = await insertRunner(db);
    await spend(6);
    await withTestActor({ type: 'RUNNER', id: runner.id }, () => evaluate(policy.id));
    expect(await rows(policy.id)).toEqual([expect.objectContaining({ actorType: 'SYSTEM', actorId: 'budget', origin: 'system' })]);
  });

  it('AC-10: rolls back a hard stop when its audit entry fails', async () => {
    const policy = await projectPolicy({ amountUsd: new Prisma.Decimal(5), warnPercent: null, hardStop: true });
    await spend(6);
    const queuedJob = await queued();
    vi.spyOn(app.get(AuditRecorder), 'record').mockImplementation(async (input) => {
      if (input.key === KEY) throw new Error('audit unavailable');
    });
    await expect(withTestActor({ type: 'SYSTEM', id: 'budget' }, () => evaluate(policy.id))).rejects.toThrow('audit unavailable');
    expect(await db.budgetPolicy.findUniqueOrThrow({ where: { id: policy.id } })).toEqual(expect.objectContaining({ pausedAt: null }));
    expect(await db.fleetJob.findUniqueOrThrow({ where: { id: queuedJob.id } })).toEqual(expect.objectContaining({ state: 'QUEUED' }));
  });
});

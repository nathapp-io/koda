/**
 * Fleet S1b slice 2a — BudgetSweeper on PG: rollover (B8), orphans, backstop evaluation.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-budget-sweeper.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { insertRunner, seedFleetBase } from '../../helpers/fleet-fixtures';
import { BudgetSweeper } from '../../../src/fleet/budgets/budget-sweeper';
import { FleetJobsService } from '../../../src/fleet/jobs/fleet-jobs.service';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('budget sweeper (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let sweeper: BudgetSweeper;
  let base: Awaited<ReturnType<typeof seedFleetBase>>;
  const NOV = new Date('2026-11-03T00:00:00.000Z');
  const OCT_START = new Date('2026-10-01T00:00:00.000Z');
  const NOV_START = new Date('2026-11-01T00:00:00.000Z');
  let n = 0;

  const policy = (over: Partial<Prisma.BudgetPolicyUncheckedCreateInput> = {}) => prisma.budgetPolicy.create({
    data: {
      scopeType: 'project', scopeId: base.projectId, scopeKey: `project:${base.projectId}`, projectId: base.projectId,
      windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(10), createdById: base.adminId, updatedById: base.adminId, ...over,
    },
  });
  const spend = (usd: number, firstStartedAt: Date) => prisma.fleetJob.create({
    data: {
      projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature: `sw${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: base.adminId, state: 'COMPLETED', costSpentUsd: usd, firstStartedAt,
    },
  });
  const reload = (id: string) => prisma.budgetPolicy.findUnique({ where: { id } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    sweeper = app.get(BudgetSweeper);
    base = await seedFleetBase(prisma);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.budgetPolicy.deleteMany();
    await prisma.fleetJob.deleteMany();
  });

  it('clears a monthly pause when the month rolls over, and keeps a lifetime pause (B8)', async () => {
    await spend(12, new Date('2026-10-20T00:00:00.000Z'));
    const monthly = await policy({ pausedAt: new Date('2026-10-20T00:00:00.000Z'), pausedWindowStart: OCT_START });
    const lifetime = await policy({ scopeKey: `project:${base.projectId}`, windowKind: 'lifetime', amountUsd: new Prisma.Decimal(100), pausedAt: OCT_START, pausedWindowStart: new Date(0) });
    const result = await sweeper.tick(NOV);
    expect(result).toEqual(expect.objectContaining({ reset: 1, deleted: 0, failed: 0 }));
    expect(await reload(monthly.id)).toEqual(expect.objectContaining({ pausedAt: null, pausedWindowStart: null }));
    expect((await reload(lifetime.id))?.pausedAt).not.toBeNull();
    const reset = await prisma.budgetIncident.findFirstOrThrow({ where: { policyId: monthly.id, kind: 'window_reset' } });
    expect(reset.windowStart).toEqual(NOV_START);
    expect(reset.spentUsd.toString()).toBe('0');
    expect(await prisma.fleetActivity.count({ where: { entityId: monthly.id, action: 'budget.window_reset' } })).toBe(1);
  });

  it('pauses again in the same tick when the new month is already over budget', async () => {
    await spend(11, new Date('2026-11-02T00:00:00.000Z'));
    const monthly = await policy({ pausedAt: OCT_START, pausedWindowStart: OCT_START });
    await sweeper.tick(NOV);
    expect(await reload(monthly.id)).toEqual(expect.objectContaining({ pausedWindowStart: NOV_START }));
    expect(await prisma.budgetIncident.count({ where: { policyId: monthly.id, kind: 'hard_stop' } })).toBe(1);
  });

  it('evaluates every policy as the backstop', async () => {
    await spend(10, new Date());
    const p = await policy({ windowKind: 'lifetime' });
    expect((await sweeper.tick()).evaluated).toBe(1);
    expect((await reload(p.id))?.pausedAt).not.toBeNull();
  });

  it('deletes the policy of a gone runner with its incidents; the leftover never blocks a dispatch (review focus 5)', async () => {
    const runner = await insertRunner(prisma);
    const orphan = await policy({
      scopeType: 'runner', scopeId: runner.id, scopeKey: `runner:${runner.id}`, projectId: null, windowKind: 'lifetime',
      pausedAt: new Date(), pausedWindowStart: new Date(0),
    });
    await prisma.budgetIncident.create({ data: { policyId: orphan.id, kind: 'hard_stop', windowStart: new Date(0), spentUsd: new Prisma.Decimal(1), amountUsd: new Prisma.Decimal(1) } });
    await prisma.runner.delete({ where: { id: runner.id } });
    const dispatched = await app.get(FleetJobsService).dispatch(base.adminId, base.projectId, { repoId: base.repoId, command: 'RUN', feature: 'after-orphan', maxCostUsd: 5 });
    expect(dispatched.job.state).toBe('QUEUED');
    expect((await sweeper.tick()).deleted).toBe(1);
    expect(await reload(orphan.id)).toBeNull();
    expect(await prisma.budgetIncident.count({ where: { policyId: orphan.id } })).toBe(0);
    expect(await prisma.fleetActivity.count({ where: { entityId: orphan.id, action: 'budget.deleted' } })).toBe(1);
  });
});

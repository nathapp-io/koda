import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet S1b slice 2a — budget repository on PG: spend, incidents, scope rows, job sets.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-budget-repository.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { insertRunner, seedFleetBase } from '../../helpers/fleet-fixtures';
import { BUDGET_REPOSITORY, DuplicateBudgetPolicyError, IBudgetRepository, NewBudgetPolicy } from '../../../src/fleet/budgets/domain/budget.domain';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('budget repository (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let repo: IBudgetRepository;
  let base: Awaited<ReturnType<typeof seedFleetBase>>;
  const OCT = new Date('2026-10-01T00:00:00.000Z');
  let n = 0;

  const insertJob = (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature: `f${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: base.adminId, state: 'COMPLETED', ...over,
    },
  });
  /** A policy is created by the admin route, so the repository runs as the admin who posts it. */
  const createPolicy = (over: Partial<NewBudgetPolicy> = {}) =>
    withTestActor({ type: 'USER', id: base.adminId }, () => repo.create(newPolicy(over)));
  /** An incident is inserted by the budget evaluator inside its transaction, as `SYSTEM/budget`. */
  const asBudget = <T>(call: () => T | PromiseLike<T>) => withTestActor({ type: 'SYSTEM', id: 'budget' }, call);
  const newPolicy = (over: Partial<NewBudgetPolicy> = {}): NewBudgetPolicy => ({
    scopeType: 'global', scopeId: null, scopeKey: 'global', projectId: null, windowKind: 'calendar_month_utc',
    amountUsd: '10', warnPercent: 80, hardStop: true, runningJobs: 'finish', createdById: base.adminId, ...over,
  });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    repo = app.get<IBudgetRepository>(BUDGET_REPOSITORY);
    base = await seedFleetBase(prisma);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.budgetPolicy.deleteMany();
    await prisma.fleetJob.deleteMany();
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('sums spent plus carried for jobs first started in the window, per scope', async () => {
    const runner = await insertRunner(prisma);
    await insertJob({ costSpentUsd: 1.5, costCarriedUsd: 0.25, firstStartedAt: new Date('2026-10-02T00:00:00Z'), runnerId: runner.id });
    await insertJob({ costSpentUsd: 2, firstStartedAt: new Date('2026-09-30T23:59:59Z') }); // previous month
    await insertJob({ costSpentUsd: 0, costCarriedUsd: 0.5 }); // never started: lifetime only
    const global = { scopeType: 'global' as const, scopeId: null };
    expect(await repo.windowSpend(global, OCT)).toBe('1.75');
    expect(await repo.windowSpend(global, null)).toBe('4.25');
    expect(await repo.windowSpend({ scopeType: 'runner', scopeId: runner.id }, OCT)).toBe('1.75');
    expect(await repo.windowSpend({ scopeType: 'repo', scopeId: base.repoId }, OCT)).toBe('1.75');
    expect(await repo.windowSpend({ scopeType: 'project', scopeId: 'nope' }, null)).toBe('0');
  });

  it('inserts a warn incident once per (policy, window, amount) without aborting the transaction', async () => {
    const p = await createPolicy();
    const tx = app.get<ITransactionManager>(TRANSACTION_MANAGER);
    const incident = { policyId: p.id, kind: 'warn' as const, windowStart: OCT, spentUsd: '8', amountUsd: '10', actorId: null };
    const results = await asBudget(() => tx.run(async () => [
      await repo.insertIncident(incident),
      await repo.insertIncident(incident),
      await repo.insertIncident({ ...incident, amountUsd: '20' }),
      await repo.insertIncident({ ...incident, kind: 'resumed' }),
      await repo.insertIncident({ ...incident, kind: 'resumed' }),
    ]));
    expect(results).toEqual([true, false, true, true, true]);
    expect(await prisma.budgetIncident.count({ where: { policyId: p.id } })).toBe(4);
  });

  it('refuses a second policy for one scope and window', async () => {
    await createPolicy();
    await expect(createPolicy()).rejects.toBeInstanceOf(DuplicateBudgetPolicyError);
  });

  it('knows which scope rows exist, treating a soft-deleted project as gone (D166)', async () => {
    const runner = await insertRunner(prisma);
    expect(await repo.scopeExists({ scopeType: 'global', scopeId: null })).toBe(true);
    expect(await repo.scopeExists({ scopeType: 'project', scopeId: base.projectId })).toBe(true);
    expect(await repo.scopeExists({ scopeType: 'repo', scopeId: base.repoId })).toBe(true);
    expect(await repo.scopeExists({ scopeType: 'runner', scopeId: runner.id })).toBe(true);
    expect(await repo.scopeExists({ scopeType: 'runner', scopeId: 'gone' })).toBe(false);
    expect(await repo.findRepoProjectId(base.repoId)).toBe(base.projectId);
    expect(await repo.findRepoProjectId('gone')).toBeNull();
    const other = await seedFleetBase(prisma);
    await prisma.project.update({ where: { id: other.projectId }, data: { deletedAt: new Date() } });
    expect(await repo.scopeExists({ scopeType: 'project', scopeId: other.projectId })).toBe(false);
  });

  it('lists QUEUED jobs pinned to a runner scope and the ASSIGNED or RUNNING jobs it holds', async () => {
    const runner = await insertRunner(prisma);
    const pinned = await insertJob({ state: 'QUEUED', pinnedRunnerId: runner.id });
    await insertJob({ state: 'QUEUED' });
    const running = await insertJob({ state: 'RUNNING', runnerId: runner.id });
    const assigned = await insertJob({ state: 'ASSIGNED', runnerId: runner.id });
    await insertJob({ state: 'UPLOADING', runnerId: runner.id });
    const scope = { scopeType: 'runner' as const, scopeId: runner.id };
    expect(await repo.findQueuedJobIds(scope)).toEqual([pinned.id]);
    expect((await repo.findHeldJobIds(scope)).sort()).toEqual([running.id, assigned.id].sort());
    expect(await repo.findQueuedJobIds({ scopeType: 'global', scopeId: null })).toHaveLength(2);
  });

  it('shows a project its own policies and the global ones, not another project\'s', async () => {
    const other = await seedFleetBase(prisma);
    await createPolicy();
    await createPolicy({ scopeType: 'project', scopeId: base.projectId, scopeKey: `project:${base.projectId}`, projectId: base.projectId });
    await createPolicy({ scopeType: 'repo', scopeId: base.repoId, scopeKey: `repo:${base.repoId}`, projectId: base.projectId });
    await createPolicy({ scopeType: 'project', scopeId: other.projectId, scopeKey: `project:${other.projectId}`, projectId: other.projectId });
    const runner = await insertRunner(prisma);
    await createPolicy({ scopeType: 'runner', scopeId: runner.id, scopeKey: `runner:${runner.id}` });
    expect((await repo.findVisibleToProject(base.projectId)).map((p) => p.scopeType).sort()).toEqual(['global', 'project', 'repo']);
    expect((await repo.findPaused())).toEqual([]);
  });
});

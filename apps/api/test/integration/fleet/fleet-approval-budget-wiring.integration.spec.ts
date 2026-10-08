/**
 * Fleet S1.5 slice 1a — budgets open and close approvals: hard stop, manual resume, rollover, delete, orphan (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-approval-budget-wiring.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { BudgetEvaluator } from '../../../src/fleet/budgets/budget-evaluator';
import { BudgetsService } from '../../../src/fleet/budgets/budgets.service';
import { BudgetSweeper } from '../../../src/fleet/budgets/budget-sweeper';
import { ProjectEventBus } from '../../../src/live/project-event-bus';
import type { LiveEvent } from '../../../src/live/live-event';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(20_000);

describeIntegration('budget approval wiring (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let evaluator: BudgetEvaluator;
  let budgets: BudgetsService;
  let sweeper: BudgetSweeper;
  const seen: LiveEvent[] = [];
  let n = 0;

  const projectPolicy = (over: Partial<Prisma.BudgetPolicyUncheckedCreateInput> = {}) => prisma.budgetPolicy.create({
    data: {
      scopeType: 'project', scopeId: world.projectId, scopeKey: `project:${world.projectId}`, projectId: world.projectId,
      windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(10), warnPercent: null,
      createdById: world.ids.root, updatedById: world.ids.dev, ...over,
    },
  });
  const job = (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `bw${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.dev, state: 'COMPLETED', firstStartedAt: new Date(), ...over,
    },
  });
  // `createdAt` is a TIMESTAMP(3) column and these pairs are created ~20 ms apart, so the id tiebreak is
  // the repo idiom and keeps six assertions from depending on that gap.
  const approvals = (policyId: string) => prisma.fleetApproval.findMany({ where: { policyId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const hooks = (event: string) => prisma.outboxEvent.count({ where: { type: 'webhook_delivery', payload: { contains: `"event":"${event}"` } } });
  const project = { kind: 'project' as const, projectId: '' };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    evaluator = app.get(BudgetEvaluator);
    budgets = app.get(BudgetsService);
    sweeper = app.get(BudgetSweeper);
    project.projectId = world.projectId;
    app.get(ProjectEventBus).subscribe(world.projectId, (e) => seen.push(e));
    await prisma.webhook.create({
      data: { projectId: world.projectId, url: 'https://hooks.example.com/koda', secret: 's'.repeat(32), events: JSON.stringify(['fleet.approval.requested', 'fleet.approval.resolved']) },
    });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.budgetPolicy.deleteMany();
    await prisma.fleetApproval.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.outboxEvent.deleteMany();
    await prisma.fleetActivity.deleteMany();
    seen.length = 0;
  });

  it('a hard stop opens one pending approval, stamps the incident, sends the webhook and a live event', async () => {
    const policy = await projectPolicy();
    await job({ costSpentUsd: 10 });
    expect((await evaluator.evaluate(policy.id)).stopped).toBe(true);
    const [a] = await approvals(policy.id);
    expect(a).toEqual(expect.objectContaining({ type: 'budget_override_required', status: 'pending', projectId: world.projectId }));
    expect(a.payload).toEqual(expect.objectContaining({ spentUsd: '10', amountUsd: '10', scopeType: 'project' }));
    const incident = await prisma.budgetIncident.findFirstOrThrow({ where: { policyId: policy.id, kind: 'hard_stop' } });
    expect(incident.approvalId).toBe(a.id);
    expect(await hooks('fleet.approval.requested')).toBe(1);
    expect(seen).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'fleet_approval', approvalId: a.id, status: 'pending' })]));
    expect(await prisma.fleetActivity.count({ where: { entityType: 'approval', entityId: a.id, action: 'approval.requested' } })).toBe(1);
  });

  it('a manual resume closes it as manual_resume and stamps the resumed incident', async () => {
    const policy = await projectPolicy();
    await job({ costSpentUsd: 10 });
    await evaluator.evaluate(policy.id);
    await budgets.resume(world.ids.root, project, policy.id, 20);
    const [a] = await approvals(policy.id);
    expect(a).toEqual(expect.objectContaining({ status: 'approved', resolvedBy: 'manual_resume', decision: 'raise_budget_and_resume', decidedById: world.ids.root }));
    expect(a.outcome).toEqual({ resumedAmountUsd: '20', requeueResults: [] });
    expect((await prisma.budgetIncident.findFirstOrThrow({ where: { policyId: policy.id, kind: 'resumed' } })).approvalId).toBe(a.id);
    expect(await hooks('fleet.approval.resolved')).toBe(1);
  });

  it('a resume with an approvalId stamps it and closes nothing', async () => {
    const policy = await projectPolicy();
    await job({ costSpentUsd: 10 });
    await evaluator.evaluate(policy.id);
    const [pending] = await approvals(policy.id);
    await budgets.resume(world.ids.root, project, policy.id, 20, new Date(), { approvalId: pending.id });
    expect((await approvals(policy.id))[0].status).toBe('pending');
    expect((await prisma.budgetIncident.findFirstOrThrow({ where: { policyId: policy.id, kind: 'resumed' } })).approvalId).toBe(pending.id);
  });

  it('policy delete closes it as policy_deleted (review focus 3)', async () => {
    const policy = await projectPolicy();
    await job({ costSpentUsd: 10 });
    await evaluator.evaluate(policy.id);
    await budgets.remove(world.ids.root, project, policy.id);
    expect((await approvals(policy.id))[0]).toEqual(expect.objectContaining({ status: 'cancelled', resolvedBy: 'policy_deleted', decidedById: null }));
  });

  it('the month rollover closes it as window_reset', async () => {
    const lastMonth = new Date(Date.UTC(2026, 8, 1));
    const policy = await projectPolicy({ pausedAt: lastMonth, pausedWindowStart: lastMonth });
    await prisma.fleetApproval.create({ data: { type: 'budget_override_required', projectId: world.projectId, policyId: policy.id, payload: {}, requestedAt: lastMonth } });
    await sweeper.tick();
    expect((await approvals(policy.id))[0]).toEqual(expect.objectContaining({ status: 'cancelled', resolvedBy: 'window_reset' }));
  });

  it('the orphan sweep closes it as policy_deleted', async () => {
    const policy = await prisma.budgetPolicy.create({
      data: { scopeType: 'runner', scopeId: 'gone', scopeKey: 'runner:gone', windowKind: 'lifetime', amountUsd: new Prisma.Decimal(1), pausedAt: new Date(), createdById: world.ids.root, updatedById: world.ids.root },
    });
    await prisma.fleetApproval.create({ data: { type: 'budget_override_required', policyId: policy.id, payload: {}, requestedAt: new Date() } });
    await sweeper.tick();
    expect((await approvals(policy.id))[0]).toEqual(expect.objectContaining({ status: 'cancelled', resolvedBy: 'policy_deleted' }));
  });

  it('a stop after a resume at the same amount still opens an approval with no new incident (D228)', async () => {
    // `lifetime` rather than the project default `calendar_month_utc`: two `evaluate`s straddling a UTC
    // month boundary would fall in different windows and insert a second `hard_stop`, reading 2 here.
    const policy = await projectPolicy({ windowKind: 'lifetime' });
    await job({ costSpentUsd: 10 });
    await evaluator.evaluate(policy.id);
    await prisma.budgetPolicy.update({ where: { id: policy.id }, data: { pausedAt: null, pausedWindowStart: null } });
    await prisma.fleetApproval.updateMany({ where: { policyId: policy.id }, data: { status: 'approved', resolvedBy: 'manual_resume' } });
    expect((await evaluator.evaluate(policy.id)).stopped).toBe(true);
    expect((await approvals(policy.id)).map((a) => a.status)).toEqual(['approved', 'pending']);
    expect(await prisma.budgetIncident.count({ where: { policyId: policy.id, kind: 'hard_stop' } })).toBe(1);
    expect(await hooks('fleet.approval.requested')).toBe(2);
  });
});

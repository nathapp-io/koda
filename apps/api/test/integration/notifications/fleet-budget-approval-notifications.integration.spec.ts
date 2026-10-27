import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet S4a §2.4 — budget incidents and approval asks on PG: enqueued inside evaluate's transaction (rolled back
 * with it), a global policy enqueues without a project (D512), admins only, stale asks skipped (D514).
 * Run: cd apps/api && bun run test:scoped test/integration/notifications/fleet-budget-approval-notifications.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { asTestActor, expectGuardActive, fixtureDb } from '../../helpers/action-context';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { outboxRecord } from '../../helpers/outbox-record';
import { FanOutPublisher } from '../../../src/outbox/fan-out-publisher';
import { BudgetEvaluator } from '../../../src/fleet/budgets/budget-evaluator';
import { FleetJobsService } from '../../../src/fleet/jobs/fleet-jobs.service';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

vi.setConfig({ testTimeout: 20_000 });

describeIntegration('fleet budget and approval notifications (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let evaluator: BudgetEvaluator;
  let publisher: FanOutPublisher;
  let n = 0;

  const policy = (over: Partial<Prisma.BudgetPolicyUncheckedCreateInput> = {}) => prisma.budgetPolicy.create({
    data: {
      scopeType: 'project', scopeId: world.projectId, scopeKey: `project:${world.projectId}`, projectId: world.projectId,
      windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(10), warnPercent: 50,
      createdById: world.ids.root, updatedById: world.ids.root, ...over,
    },
  });
  const spent = (usd: number) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `bud${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(50), selectorLabels: [], requestedById: world.ids.dev, state: 'COMPLETED', firstStartedAt: new Date(), costSpentUsd: usd,
    },
  });
  const events = (type: string) => prisma.outboxEvent.findMany({ where: { type }, orderBy: { createdAt: 'asc' } });
  const deliver = async (type: string): Promise<void> => {
    for (const row of await events(type)) {
      await publisher.publish(outboxRecord(row.type, JSON.parse(row.payload), { id: row.id, metadata: { projectId: row.projectId, eventId: row.eventId } }));
    }
  };
  const notes = (userId: string) => prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true });
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    // `evaluate` runs below two wrapped entries: the sync path's `signal` and `BudgetSweeper.tick`,
    // whose `system.budget.window-reset` key makes the budget component the actor.
    evaluator = asTestActor(app.get(BudgetEvaluator), { type: 'SYSTEM', id: 'budget' });
    publisher = app.get(FanOutPublisher);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.budgetPolicy.deleteMany();
    await prisma.fleetApprovalAsk.deleteMany();
    await prisma.approvalRequest.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.outboxEvent.deleteMany();
    await prisma.notification.deleteMany();
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('warn: one event per incident, admins notified once, members not', async () => {
    const p = await policy();
    await spent(6);
    await evaluator.evaluate(p.id);
    await evaluator.evaluate(p.id);
    const rows = await events('fleet_budget_incident');
    expect(rows).toHaveLength(1);
    expect(rows[0].projectId).toBe(world.projectId);
    await deliver('fleet_budget_incident');
    await deliver('fleet_budget_incident');
    expect((await notes(world.ids.root)).map((x) => [x.kind, x.category])).toEqual([['budget_warn', 'FLEET_HEALTH']]);
    expect(await notes(world.ids.dev)).toEqual([]);
  });

  it('a global policy enqueues without a project and still notifies admins', async () => {
    const p = await policy({ scopeType: 'global', scopeId: null, scopeKey: 'global', projectId: null });
    await spent(6);
    await evaluator.evaluate(p.id);
    const [row] = await events('fleet_budget_incident');
    expect(row.projectId).toBeNull();
    expect(JSON.parse(row.payload)).toMatchObject({ kind: 'warn', scope: 'global' });
    await deliver('fleet_budget_incident');
    expect((await notes(world.ids.root))[0]).toMatchObject({ kind: 'budget_warn', projectId: null, title: 'Budget global: $6.00 of $10.00' });
  });

  it('hard stop: the incident event rolls back with the evaluate transaction', async () => {
    const p = await policy({ hardStop: true });
    await spent(12);
    vi.spyOn(app.get(FleetJobsService), 'cancelForBudget').mockRejectedValueOnce(new Error('cancel failed'));
    await expect(evaluator.evaluate(p.id)).rejects.toThrow('cancel failed');
    expect(await prisma.budgetIncident.count({ where: { policyId: p.id } })).toBe(0);
    expect(await events('fleet_budget_incident')).toHaveLength(0);
    expect(await events('fleet_approval_requested')).toHaveLength(0);
  });

  it('hard stop: the override ask is announced keyed by the engine request, and a settled ask notifies nobody', async () => {
    const p = await policy({ hardStop: true });
    await spent(12);
    await evaluator.evaluate(p.id);

    // Permissions P3 US-007: the ask is an `ApprovalRequest`, and the announcement is keyed by its id.
    const [row] = await events('fleet_approval_requested');
    const ask = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: row.eventId } });
    expect(ask).toMatchObject({ permissionKey: 'fleet.budget.override', status: 'pending', projectId: world.projectId });
    expect(row.projectId).toBe(world.projectId);

    // An answered ask notifies nobody: the delivery re-reads the ask and acts only while it is pending. (The fleet's
    // reader still looks a budget ask up in `FleetApproval` — US-011 moves it onto the engine — so this pins the
    // subscriber's status gate, which is what keeps a resolved ask out of every admin's inbox.)
    await prisma.approvalRequest.update({ where: { id: ask.id }, data: { status: 'executed', settledAt: new Date() } });
    await deliver('fleet_approval_requested');
    expect(await notes(world.ids.root)).toEqual([]);
  });
});

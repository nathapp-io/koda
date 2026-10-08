/**
 * Fleet S4a §2.4 — budget incidents and approval asks on PG: enqueued inside evaluate's transaction (rolled back
 * with it), a global policy enqueues without a project (D512), admins only, stale asks skipped (D514).
 * Run: cd apps/api && bun run test:scoped test/integration/notifications/fleet-budget-approval-notifications.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { outboxRecord } from '../../helpers/outbox-record';
import { FanOutPublisher } from '../../../src/outbox/fan-out-publisher';
import { BudgetEvaluator } from '../../../src/fleet/budgets/budget-evaluator';
import { FleetJobsService } from '../../../src/fleet/jobs/fleet-jobs.service';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(20_000);

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
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    evaluator = app.get(BudgetEvaluator);
    publisher = app.get(FanOutPublisher);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.budgetPolicy.deleteMany();
    await prisma.fleetApproval.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.outboxEvent.deleteMany();
    await prisma.notification.deleteMany();
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
    jest.spyOn(app.get(FleetJobsService), 'cancelForBudget').mockRejectedValueOnce(new Error('cancel failed'));
    await expect(evaluator.evaluate(p.id)).rejects.toThrow('cancel failed');
    expect(await prisma.budgetIncident.count({ where: { policyId: p.id } })).toBe(0);
    expect(await events('fleet_budget_incident')).toHaveLength(0);
    expect(await events('fleet_approval_requested')).toHaveLength(0);
  });

  it('hard stop: the override ask reaches admins while pending; an answered ask notifies nobody', async () => {
    const p = await policy({ hardStop: true });
    await spent(12);
    await evaluator.evaluate(p.id);
    await deliver('fleet_approval_requested');
    const ask = (await notes(world.ids.root)).find((x) => x.kind === 'approval_requested');
    expect(ask).toMatchObject({ category: 'FLEET_NEEDS_YOU', link: '/admin/fleet/approvals', title: 'Approval needed: budget override on project WEB' });
    await prisma.notification.deleteMany();
    await prisma.fleetApproval.updateMany({ data: { status: 'approved', decidedAt: new Date() } });
    await deliver('fleet_approval_requested');
    expect(await notes(world.ids.root)).toEqual([]);
  });
});

import request from 'supertest';
import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet S1.5 slice 1a — budgets open and close approvals: hard stop, manual resume, rollover, delete, orphan (PG).
 *
 * Permissions P3 US-007: a budget ask is an `ApprovalRequest` with a `FleetApprovalAsk` link, so every assertion below
 * reads those two tables instead of `FleetApproval`; the need-to-decide paths go through the engine, which a held
 * request is skipped by rather than waited on.
 *
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-approval-budget-wiring.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { BudgetEvaluator } from '../../../src/fleet/budgets/budget-evaluator';
import { BudgetsService } from '../../../src/fleet/budgets/budgets.service';
import { BudgetSweeper } from '../../../src/fleet/budgets/budget-sweeper';
import { ApprovalCloser, userActor } from '../../../src/fleet/approvals/approval-closer';
import { ProjectEventBus } from '../../../src/live/project-event-bus';
import type { LiveEvent } from '../../../src/live/live-event';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';
import { seedFleetAsk } from '../../helpers/fleet-ask-fixtures';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

vi.setConfig({ testTimeout: 20_000 });

describeIntegration('budget approval wiring on the approval engine (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let evaluator: BudgetEvaluator;
  let budgets: BudgetsService;
  let sweeper: BudgetSweeper;
  let closer: ApprovalCloser;
  let txManager: ITransactionManager;
  const seen: LiveEvent[] = [];
  let n = 0;

  const projectPolicy = (over: Partial<Prisma.BudgetPolicyUncheckedCreateInput> = {}) => prisma.budgetPolicy.create({
    data: {
      scopeType: 'project', scopeId: world.projectId, scopeKey: `project:${world.projectId}`, projectId: world.projectId,
      windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(10), warnPercent: null,
      createdById: world.ids.root, updatedById: world.ids.dev, ...over,
    },
  });
  const globalPolicy = (over: Partial<Prisma.BudgetPolicyUncheckedCreateInput> = {}) => prisma.budgetPolicy.create({
    data: {
      scopeType: 'global', scopeKey: 'global', windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(1),
      warnPercent: null, createdById: world.ids.root, updatedById: world.ids.dev, ...over,
    },
  });
  const job = (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `bw${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.dev, state: 'COMPLETED', firstStartedAt: new Date(), ...over,
    },
  });

  /** The policy's budget asks as (link, request) pairs, oldest request first. */
  const asksOf = async (policyId: string) => {
    const links = await prisma.fleetApprovalAsk.findMany({
      where: { budgetPolicyId: policyId }, orderBy: [{ createdAt: 'asc' }, { requestId: 'asc' }],
    });
    return Promise.all(links.map(async (link) => ({ link, request: await requestOf(link.requestId) })));
  };
  const requestOf = (id: string) => prisma.approvalRequest.findUniqueOrThrow({ where: { id } });
  const linkOf = (requestId: string) => prisma.fleetApprovalAsk.findUniqueOrThrow({ where: { requestId } });
  const hooks = (event: string) => prisma.outboxEvent.count({ where: { type: 'webhook_delivery', payload: { contains: `"event":"${event}"` } } });
  const project = { kind: 'project' as const, projectId: '' };
  /** The owner's bearer header: a global admin holds every budget key. */
  const asRoot = () => ({ Authorization: `Bearer ${world.tokens.root}` });
  const budgetRoute = '/api/projects/web/fleet/budgets';

  /** One evaluation as the budget sweeper runs it: the wrapped entry production reaches `evaluate` from. */
  const evaluate = (policyId: string) => withTestActor({ type: 'SYSTEM', id: 'budget' }, () => evaluator.evaluate(policyId));

  /**
   * Holds `SELECT ... FOR UPDATE` on a request row from another connection while `fn` runs, then rolls back: a fleet
   * close must skip a request an in-flight decide or execute holds (US-007 AC-11, AC-13).
   */
  async function whileRequestHeld<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => { locked = resolve; });
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ApprovalRequest" WHERE "id" = ${requestId} FOR UPDATE`;
      locked();
      await released;
    }, { maxWait: 10_000, timeout: 30_000 });
    await isLocked;
    try {
      return await fn();
    } finally {
      release();
      await holder;
    }
  }

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    evaluator = app.get(BudgetEvaluator);
    budgets = app.get(BudgetsService);
    sweeper = app.get(BudgetSweeper);
    closer = app.get(ApprovalCloser);
    txManager = app.get<ITransactionManager>(TRANSACTION_MANAGER, { strict: false });
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
    await prisma.fleetApprovalAsk.deleteMany();
    await prisma.approvalRequest.deleteMany();
    await prisma.budgetPolicy.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.outboxEvent.deleteMany();
    await prisma.fleetActivity.deleteMany();
    await prisma.auditEntry.deleteMany();
    seen.length = 0;
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('AC-1: a hard stop opens one engine budget ask for the system component, linked to its policy', async () => {
    const policy = await projectPolicy();
    await job({ costSpentUsd: 10 });

    expect((await evaluate(policy.id)).stopped).toBe(true);

    const asks = await asksOf(policy.id);
    expect(asks).toHaveLength(1);
    const [{ link, request }] = asks;
    expect(request).toMatchObject({
      id: link.requestId, permissionKey: 'fleet.budget.override', status: 'pending',
      actorType: 'SYSTEM', actorId: 'budget', onBehalfOfType: null, onBehalfOfId: null, origin: 'system',
      projectId: world.projectId,
    });
    expect(link).toMatchObject({ kind: 'budget', budgetPolicyId: policy.id, projectId: world.projectId, jobId: null, resolvedBy: null });
    // The frozen input is the stop snapshot plus when the ask opened (the re-queue window's start).
    expect(request.input).toEqual({
      policyId: policy.id, scopeType: 'project', scopeId: world.projectId, windowKind: 'calendar_month_utc',
      windowStart: expect.any(String), spentUsd: '10', amountUsd: '10', requestedAt: expect.any(String),
    });
    // The pending open still announces the ask exactly as it did on the legacy row.
    expect(await prisma.fleetActivity.count({ where: { entityType: 'approval', entityId: request.id, action: 'approval.requested', actorType: 'SYSTEM' } })).toBe(1);
    expect(await hooks('fleet.approval.requested')).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { type: 'fleet_approval_requested', eventId: request.id } })).toBe(1);
    expect(seen).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'fleet_approval', approvalId: request.id, status: 'pending' })]));
  });

  it('AC-2: that hard stop stamps its incident with the request id', async () => {
    const policy = await projectPolicy();
    await job({ costSpentUsd: 10 });
    await evaluate(policy.id);

    const [{ request }] = await asksOf(policy.id);
    const incident = await prisma.budgetIncident.findFirstOrThrow({ where: { policyId: policy.id, kind: 'hard_stop' } });
    expect(incident.approvalId).toBe(request.id);
  });

  it('AC-3: with no approval policy for the key the ask expires 86 400 s after it was created', async () => {
    const policy = await projectPolicy();
    await job({ costSpentUsd: 10 });
    await evaluate(policy.id);

    const [{ request }] = await asksOf(policy.id);
    expect(request.expiresAt.getTime() - request.createdAt.getTime()).toBe(86_400_000);
  });

  it('AC-4: a second hard stop supersedes the first ask and leaves one pending', async () => {
    // `lifetime` rather than the project default `calendar_month_utc`: two `evaluate`s straddling a UTC month
    // boundary would fall in different windows and insert a second `hard_stop`, reading 2 below.
    const policy = await projectPolicy({ windowKind: 'lifetime' });
    await job({ costSpentUsd: 10 });
    await evaluate(policy.id);
    await prisma.budgetPolicy.update({ where: { id: policy.id }, data: { pausedAt: null, pausedWindowStart: null } });

    expect((await evaluate(policy.id)).stopped).toBe(true);

    const asks = await asksOf(policy.id);
    expect(asks).toHaveLength(2);
    const superseded = asks.filter(({ request }) => request.status === 'cancelled');
    const pending = asks.filter(({ request }) => request.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(superseded).toHaveLength(1);
    expect(superseded[0].request.result).toEqual({ closedBy: 'superseded' });
    expect(superseded[0].link.resolvedBy).toBe('superseded');
    // D228: the second stop of the same window is the same incident.
    expect(await prisma.budgetIncident.count({ where: { policyId: policy.id, kind: 'hard_stop' } })).toBe(1);
  });

  it('AC-5: the month rollover settles the pending ask window_reset and stamps the reset incident', async () => {
    const lastMonth = new Date(Date.UTC(2026, 8, 1));
    const policy = await projectPolicy({ pausedAt: lastMonth, pausedWindowStart: lastMonth });
    const { requestId } = await seedFleetAsk(prisma, {
      kind: 'budget', projectId: world.projectId, createdAt: lastMonth,
      input: {
        policyId: policy.id, scopeType: 'project', scopeId: world.projectId, windowKind: 'calendar_month_utc',
        windowStart: lastMonth.toISOString(), spentUsd: '10', amountUsd: '10', requestedAt: lastMonth.toISOString(),
      },
      link: { budgetPolicyId: policy.id },
    });

    await sweeper.tick();

    expect(await requestOf(requestId)).toMatchObject({ status: 'cancelled', result: { closedBy: 'window_reset' } });
    expect((await linkOf(requestId)).resolvedBy).toBe('window_reset');
    expect((await prisma.budgetIncident.findFirstOrThrow({ where: { policyId: policy.id, kind: 'window_reset' } })).approvalId).toBe(requestId);
  });

  it('AC-6: the orphan sweep settles the ask policy_deleted', async () => {
    const policy = await prisma.budgetPolicy.create({
      data: { scopeType: 'runner', scopeId: 'gone', scopeKey: 'runner:gone', windowKind: 'lifetime', amountUsd: new Prisma.Decimal(1), pausedAt: new Date(), createdById: world.ids.root, updatedById: world.ids.root },
    });
    const { requestId } = await seedFleetAsk(prisma, {
      kind: 'budget', projectId: null,
      input: {
        policyId: policy.id, scopeType: 'runner', scopeId: 'gone', windowKind: 'lifetime',
        windowStart: '1970-01-01T00:00:00.000Z', spentUsd: '0', amountUsd: '1', requestedAt: new Date().toISOString(),
      },
      link: { budgetPolicyId: policy.id },
    });

    await sweeper.tick();

    expect(await requestOf(requestId)).toMatchObject({ status: 'cancelled', result: { closedBy: 'policy_deleted' } });
    expect((await linkOf(requestId)).resolvedBy).toBe('policy_deleted');
  });

  it('AC-7: DELETE on the budget route settles the ask policy_deleted and records an approval.cancelled activity row', async () => {
    const policy = await projectPolicy();
    await job({ costSpentUsd: 10 });
    await evaluate(policy.id);
    const [{ request: ask }] = await asksOf(policy.id);

    await request(app.getHttpServer()).delete(`${budgetRoute}/${policy.id}`).set(asRoot()).expect(204);

    expect(await requestOf(ask.id)).toMatchObject({ status: 'cancelled', result: { closedBy: 'policy_deleted' } });
    expect((await linkOf(ask.id)).resolvedBy).toBe('policy_deleted');
    expect(await prisma.fleetActivity.findMany({ where: { entityType: 'approval', entityId: ask.id, action: 'approval.cancelled' } }))
      .toMatchObject([{ actorType: 'USER', actorId: world.ids.root }]);
  });

  it('AC-8: the resume route settles the ask cancelled and stamps the link manual_resume', async () => {
    const policy = await projectPolicy();
    await job({ costSpentUsd: 10 });
    await evaluate(policy.id);
    const [{ request: ask }] = await asksOf(policy.id);

    await request(app.getHttpServer()).post(`${budgetRoute}/${policy.id}/resume`).set(asRoot()).send({ amountUsd: 20 }).expect(200);

    // The engine status is always `cancelled`; the fleet reports the resume as `approved` from the link's resolution.
    expect(await requestOf(ask.id)).toMatchObject({ status: 'cancelled', result: { closedBy: 'manual_resume' } });
    expect((await linkOf(ask.id)).resolvedBy).toBe('manual_resume');
  });

  it('AC-9: that resume leaves the link outcome with the raised amount, no re-queues and the caller', async () => {
    const policy = await projectPolicy();
    await job({ costSpentUsd: 10 });
    await evaluate(policy.id);
    const [{ request: ask }] = await asksOf(policy.id);

    await request(app.getHttpServer()).post(`${budgetRoute}/${policy.id}/resume`).set(asRoot()).send({ amountUsd: 20 }).expect(200);

    expect((await linkOf(ask.id)).outcome).toEqual({ resumedAmountUsd: '20', requeueResults: [], resumedById: world.ids.root });
    // `BudgetsService.resume` reads the closed view's id for the incident, so the resume must still answer one.
    expect((await prisma.budgetIncident.findFirstOrThrow({ where: { policyId: policy.id, kind: 'resumed' } })).approvalId).toBe(ask.id);
  });

  it('AC-10: a global policy asks with no project and records no fleet_approval_requested event', async () => {
    const policy = await globalPolicy();
    await job({ costSpentUsd: 10 });

    expect((await evaluate(policy.id)).stopped).toBe(true);

    const [{ link, request }] = await asksOf(policy.id);
    expect(request.projectId).toBeNull();
    expect(link.projectId).toBeNull();
    expect(await prisma.outboxEvent.count({ where: { type: 'fleet_approval_requested' } })).toBe(0);
    expect(await hooks('fleet.approval.requested')).toBe(0);
    expect(seen).toEqual([]);
  });

  it('AC-11: a DELETE while the ask row is held still commits and leaves the ask pending', async () => {
    const policy = await projectPolicy();
    await job({ costSpentUsd: 10 });
    await evaluate(policy.id);
    const [{ request: ask }] = await asksOf(policy.id);

    await whileRequestHeld(ask.id, () =>
      request(app.getHttpServer()).delete(`${budgetRoute}/${policy.id}`).set(asRoot()).expect(204));

    expect(await prisma.budgetPolicy.count({ where: { id: policy.id } })).toBe(0);
    expect(await requestOf(ask.id)).toMatchObject({ status: 'pending', result: null });
    expect((await linkOf(ask.id)).resolvedBy).toBeNull();
  });

  it('AC-13: closeForPolicy inside the policy transaction answers nothing while the ask row is held', async () => {
    const policy = await projectPolicy();
    await job({ costSpentUsd: 10 });
    await evaluate(policy.id);
    const [{ request: ask }] = await asksOf(policy.id);

    const closed = await whileRequestHeld(ask.id, () =>
      withTestActor({ type: 'USER', id: world.ids.root }, () =>
        txManager.run(() => closer.closeForPolicy(policy.id, { status: 'cancelled', resolvedBy: 'policy_deleted', actor: userActor(world.ids.root) }, new Date()))));

    expect(closed).toEqual({ approval: null, live: [] });
    expect(await requestOf(ask.id)).toMatchObject({ status: 'pending', result: null });
    expect((await linkOf(ask.id)).resolvedBy).toBeNull();
    expect(await prisma.fleetActivity.count({ where: { entityType: 'approval', entityId: ask.id, action: 'approval.cancelled' } })).toBe(0);
  });

  it('F3: a held ask does not leave another pending ask of the same policy behind', async () => {
    const policy = await projectPolicy();
    await job({ costSpentUsd: 10 });
    await evaluate(policy.id);
    // Reachable in production: an earlier close skipped this held request, and a later hard stop opened a newer ask.
    const newer = await seedFleetAsk(prisma, {
      kind: 'budget', projectId: world.projectId,
      input: {
        policyId: policy.id, scopeType: 'project', scopeId: world.projectId, windowKind: 'calendar_month_utc',
        windowStart: new Date().toISOString(), spentUsd: '10', amountUsd: '10', requestedAt: new Date().toISOString(),
      },
      link: { budgetPolicyId: policy.id },
    });
    const asks = await asksOf(policy.id);
    const held = asks.find(({ request }) => request.id !== newer.requestId) ?? asks[0];

    expect(await prisma.approvalRequest.count({ where: { id: { in: asks.map(({ request }) => request.id) }, status: 'pending' } })).toBe(2);

    await whileRequestHeld(held.request.id, () =>
      request(app.getHttpServer()).delete(`${budgetRoute}/${policy.id}`).set(asRoot()).expect(204));

    expect(await requestOf(held.request.id)).toMatchObject({ status: 'pending', result: null });
    expect(await requestOf(newer.requestId)).toMatchObject({ status: 'cancelled', result: { closedBy: 'policy_deleted' } });
    expect((await linkOf(newer.requestId)).resolvedBy).toBe('policy_deleted');
  });

  it('a resume with an approvalId stamps it and closes nothing', async () => {
    const policy = await projectPolicy();
    await job({ costSpentUsd: 10 });
    await evaluate(policy.id);
    const [{ request: ask }] = await asksOf(policy.id);

    await withTestActor({ type: 'USER', id: world.ids.root }, () =>
      budgets.resume(world.ids.root, project, policy.id, 20, new Date(), { approvalId: ask.id }));

    expect((await requestOf(ask.id)).status).toBe('pending');
    expect((await prisma.budgetIncident.findFirstOrThrow({ where: { policyId: policy.id, kind: 'resumed' } })).approvalId).toBe(ask.id);
  });
});

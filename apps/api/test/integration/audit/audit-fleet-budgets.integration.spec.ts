import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, type PrismaClient } from '../../../src/generated/prisma/client';
import { BudgetEvaluator } from '../../../src/fleet/budgets/budget-evaluator';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { canRunDbTests } from '../../helpers/test-environment';
import { bootHttpApp, data } from '../../helpers/http-app';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { type FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';

const describeDb = canRunDbTests() ? describe : describe.skip;

describeDb('fleet budget audit HTTP', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  const admin = '/api/fleet/budgets';
  const project = '/api/projects/web/fleet/budgets';
  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });
  const createProject = () => request(app.getHttpServer()).post(project).set(auth('root')).send({ scopeType: 'project', windowKind: 'calendar_month_utc', amountUsd: 10 });
  const entries = (resourceId: string, key: string) => db.auditEntry.findMany({ where: { resourceId, key } });
  const pausedPolicy = () => db.budgetPolicy.create({ data: {
    scopeType: 'project', scopeId: world.projectId, scopeKey: `project:${world.projectId}`, projectId: world.projectId,
    windowKind: 'calendar_month_utc', amountUsd: '10', warnPercent: null, createdById: world.ids.root, updatedById: world.ids.root,
    pausedAt: new Date(), pausedWindowStart: new Date(0),
  } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    await db.fleetApprovalAsk.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.fleetJob.deleteMany();
    await db.budgetPolicy.deleteMany();
    await db.auditEntry.deleteMany();
  });
  afterEach(() => vi.restoreAllMocks());

  it('AC-1/2: records global and project creates with route actor and scope metadata', async () => {
    const global = data<{ id: string }>(await request(app.getHttpServer()).post(admin).set(auth('root')).send({ scopeType: 'global', windowKind: 'calendar_month_utc', amountUsd: 10 }).expect(201));
    expect(await entries(global.id, 'fleet.budget.create')).toEqual([expect.objectContaining({ resourceType: 'fleet-budget', projectId: null, actorType: 'USER', actorId: world.ids.root, origin: 'rest', summary: 'created global policy' })]);
    const projectPolicy = data<{ id: string }>(await createProject().expect(201));
    expect(await entries(projectPolicy.id, 'fleet.budget.create')).toEqual([expect.objectContaining({ projectId: world.projectId, summary: 'created project policy' })]);
  });

  it('AC-3/4: only committed creations add entries', async () => {
    const before = await db.auditEntry.count({ where: { key: 'fleet.budget.create', projectId: world.projectId } });
    await createProject().expect(201);
    await createProject().expect(409);
    expect(await db.auditEntry.count({ where: { key: 'fleet.budget.create', projectId: world.projectId } })).toBe(before + 1);
    await request(app.getHttpServer()).post(project).set(auth('dev')).send({ scopeType: 'project', windowKind: 'lifetime', amountUsd: 4 }).expect(403);
    expect(await db.auditEntry.count({ where: { key: 'fleet.budget.create', actorId: world.ids.dev } })).toBe(0);
  });

  it('AC-5: audit failure rolls back policy creation', async () => {
    vi.spyOn(app.get(AuditRecorder), 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    await createProject().expect(500);
    expect(await db.budgetPolicy.count({ where: { projectId: world.projectId } })).toBe(0);
    expect(await db.auditEntry.count({ where: { key: 'fleet.budget.create' } })).toBe(0);
  });

  it('AC-6/7/8: audits update and deletes with safe summaries and pause state', async () => {
    const updated = data<{ id: string }>(await createProject().expect(201));
    await request(app.getHttpServer()).patch(`${project}/${updated.id}`).set(auth('root')).send({ amountUsd: 30, hardStop: false }).expect(200);
    expect(await entries(updated.id, 'fleet.budget.update')).toEqual([expect.objectContaining({ summary: 'fields: amountUsd, hardStop' })]);
    await request(app.getHttpServer()).delete(`${project}/${updated.id}`).set(auth('root')).expect(204);
    expect(await entries(updated.id, 'fleet.budget.delete')).toEqual([expect.objectContaining({ summary: 'deleted' })]);

    const paused = await db.budgetPolicy.create({ data: {
      scopeType: 'global', scopeKey: 'global', windowKind: 'lifetime', amountUsd: '10', warnPercent: null,
      createdById: world.ids.root, updatedById: world.ids.root, pausedAt: new Date(), pausedWindowStart: new Date(0),
    } });
    await request(app.getHttpServer()).delete(`${admin}/${paused.id}`).set(auth('root')).expect(204);
    expect(await entries(paused.id, 'fleet.budget.delete')).toEqual([expect.objectContaining({ projectId: null, summary: 'deleted while paused' })]);
  });

  it('AC-11: a budget decision records only the approval audit, not a route resume', async () => {
    const policy = await db.budgetPolicy.create({ data: {
      scopeType: 'project', scopeId: world.projectId, scopeKey: `project:${world.projectId}`, projectId: world.projectId,
      windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(10), warnPercent: null,
      createdById: world.ids.root, updatedById: world.ids.root,
    } });
    await db.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: 'audit-budget-spend', profiles: [],
      maxCostUsd: new Prisma.Decimal(20), selectorLabels: [], requestedById: world.ids.dev, state: 'COMPLETED',
      costSpentUsd: new Prisma.Decimal(10), firstStartedAt: new Date(),
    } });
    await db.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: 'audit-budget-queued', profiles: [],
      maxCostUsd: new Prisma.Decimal(20), selectorLabels: [], requestedById: world.ids.dev, state: 'QUEUED',
    } });
    await withTestActor({ type: 'SYSTEM', id: 'budget' }, () => app.get(BudgetEvaluator).evaluate(policy.id));
    // Permissions P3 US-007: the hard stop opens an engine ask, so the decision goes through the engine's route —
    // the fleet decide adapter still serves `FleetApproval` until US-010.
    const link = await db.fleetApprovalAsk.findFirstOrThrow({ where: { budgetPolicyId: policy.id } });
    await request(app.getHttpServer()).post(`/api/approvals/${link.requestId}/decisions`).set(auth('root'))
      .send({ decision: 'approve', params: { amountUsd: 20 } }).expect(200);
    // The raise resumed the policy through the command, so the route's own resume audit must not appear.
    expect(await entries(policy.id, 'fleet.budget.resume')).toHaveLength(0);
    expect(await entries(link.requestId, 'fleet.budget.override')).toHaveLength(1);
  });

  it('AC-9/10: records only a successful budget-page resume', async () => {
    const paused = await pausedPolicy();
    await request(app.getHttpServer()).post(`${project}/${paused.id}/resume`).set(auth('root')).send({ amountUsd: 20 }).expect(200);
    expect(await entries(paused.id, 'fleet.budget.resume')).toEqual([expect.objectContaining({ summary: 'resumed' })]);
    const active = await db.budgetPolicy.create({ data: {
      scopeType: 'project', scopeId: world.projectId, scopeKey: `project:${world.projectId}:active`, projectId: world.projectId,
      windowKind: 'lifetime', amountUsd: '10', warnPercent: null, createdById: world.ids.root, updatedById: world.ids.root,
    } });
    await request(app.getHttpServer()).post(`${project}/${active.id}/resume`).set(auth('root')).send({ amountUsd: 20 }).expect(409);
    expect(await entries(active.id, 'fleet.budget.resume')).toHaveLength(0);
  });
});

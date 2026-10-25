import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { BudgetEvaluator } from '../../../src/fleet/budgets/budget-evaluator';
import { fixtureDb, withTestActor } from '../../helpers/action-context';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

describeIntegration('fleet approval audit rows (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let padmin: string;
  let padminId: string;
  let n = 0;
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const tok = (who: keyof FleetHttpWorld['tokens']) => as(world.tokens[who]);
  const project = '/api/projects/web/fleet/approvals';
  const admin = '/api/fleet/approvals';
  const job = (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: { projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `audit-ap-${++n}`, profiles: [], maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.dev, state: 'COMPLETED', firstStartedAt: new Date(), ...over },
  });
  const startPendingBudget = async (scope: 'project' | 'global' = 'project') => {
    const policy = await prisma.budgetPolicy.create({ data: scope === 'project'
      ? { scopeType: 'project', scopeId: world.projectId, scopeKey: `project:${world.projectId}`, projectId: world.projectId, windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(10), warnPercent: null, createdById: world.ids.root, updatedById: world.ids.root }
      : { scopeType: 'global', scopeKey: 'global', windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(10), warnPercent: null, createdById: world.ids.root, updatedById: world.ids.root } });
    await job({ costSpentUsd: 10 });
    const queued = await job({ state: 'QUEUED', firstStartedAt: null });
    await withTestActor({ type: 'SYSTEM', id: 'budget' }, () => app.get(BudgetEvaluator).evaluate(policy.id));
    const approval = await prisma.fleetApproval.findFirstOrThrow({ where: { policyId: policy.id, status: 'pending' } });
    return { policy, queued, approval };
  };
  const entries = (resourceId: string, key: string) => prisma.auditEntry.findMany({ where: { resourceId, key } });
  const bashApproval = async (over: { state?: string; expiresAt?: Date } = {}) => {
    const running = await job({ state: over.state ?? 'RUNNING', runnerId: runnerId, leaseEpoch: 1, bashMode: 'escalate' });
    const approval = await prisma.fleetApproval.create({ data: {
      type: 'nax_bash_escalate', projectId: world.projectId, jobId: running.id, leaseEpoch: running.leaseEpoch,
      naxAskId: `audit-ask-${++n}`, requestedAt: new Date(), expiresAt: over.expiresAt ?? new Date(Date.now() + 300_000),
      payload: { command: 'bun test', commandTruncated: false, options: ['allow', 'deny'] },
    } });
    return { running, approval };
  };
  let runnerId: string;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    runnerId = (await insertRunner(prisma, { createdById: world.ids.root, enabled: false })).id;
    await request(server).post('/api/admin/users').set(tok('root')).send({ email: 'approval-audit-admin@koda.test', name: 'approval audit admin', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    await request(server).post('/api/projects/web/members').set(tok('root')).send({ email: 'approval-audit-admin@koda.test', roleKey: 'project-admin' }).expect(201);
    padmin = await loginToken(server, 'approval-audit-admin@koda.test');
    padminId = (await prisma.user.findUniqueOrThrow({ where: { email: 'approval-audit-admin@koda.test' } })).id;
  });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => {
    await prisma.auditEntry.deleteMany();
    await prisma.budgetPolicy.deleteMany();
    await prisma.fleetApproval.deleteMany();
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.outboxEvent.deleteMany();
  });

  it('AC-1/2: records keep-paused with actor, resource, summary and project; global scope is null', async () => {
    const { approval } = await startPendingBudget();
    await request(server).post(`${project}/${approval.id}/decide`).set(as(padmin)).send({ decision: 'keep_paused' }).expect(200);
    const [entry] = await entries(approval.id, 'fleet.approval.decide.budget');
    expect(entry).toMatchObject({ key: 'fleet.approval.decide.budget', resourceType: 'fleet-approval', resourceId: approval.id, actorType: 'USER', actorId: padminId, summary: 'decision: keep_paused', projectId: world.projectId });

    const global = await startPendingBudget('global');
    await request(server).post(`${admin}/${global.approval.id}/decide`).set(tok('root')).send({ decision: 'keep_paused' }).expect(200);
    expect(await entries(global.approval.id, 'fleet.approval.decide.budget')).toHaveLength(1);
    expect((await entries(global.approval.id, 'fleet.approval.decide.budget'))[0]).toMatchObject({ projectId: null, summary: 'decision: keep_paused' });
  });

  it('AC-3/4: raise-and-resume writes approval and separately requeued job entries', async () => {
    const { approval, queued } = await startPendingBudget();
    await request(server).post(`${project}/${approval.id}/decide`).set(as(padmin)).send({ decision: 'raise_budget_and_resume', amountUsd: 25, requeueJobIds: [queued.id] }).expect(200);
    expect(await entries(approval.id, 'fleet.approval.decide.budget')).toHaveLength(1);
    expect((await entries(approval.id, 'fleet.approval.decide.budget'))[0]).toMatchObject({ summary: 'decision: raise_budget_and_resume' });
    expect(await entries(queued.id, 'fleet.job.requeue')).toHaveLength(1);
  });

  it('AC-5/7: refused budget and unauthorized bash decisions do not record', async () => {
    const { approval } = await startPendingBudget();
    await request(server).post(`${project}/${approval.id}/decide`).set(as(padmin)).send({ decision: 'keep_paused' }).expect(200);
    await request(server).post(`${project}/${approval.id}/decide`).set(as(padmin)).send({ decision: 'keep_paused' }).expect(409);
    expect(await entries(approval.id, 'fleet.approval.decide.budget')).toHaveLength(1);

    const { approval: bash } = await bashApproval();
    await request(server).post(`${project}/${bash.id}/decide`).set(tok('viewer')).send({ decision: 'deny' }).expect(403);
    expect(await entries(bash.id, 'fleet.approval.decide.bash')).toHaveLength(0);
  });

  it('AC-6/8/9/11: records a valid bash decision only; ended, expired and repeated asks add none', async () => {
    const { approval: valid } = await bashApproval();
    await request(server).post(`${project}/${valid.id}/decide`).set(as(padmin)).send({ decision: 'deny' }).expect(200);
    expect(await entries(valid.id, 'fleet.approval.decide.bash')).toHaveLength(1);
    expect((await entries(valid.id, 'fleet.approval.decide.bash'))[0]).toMatchObject({ summary: 'decision: deny', resourceType: 'fleet-approval', projectId: world.projectId });
    await request(server).post(`${project}/${valid.id}/decide`).set(as(padmin)).send({ decision: 'deny' }).expect(409);
    expect(await entries(valid.id, 'fleet.approval.decide.bash')).toHaveLength(1);

    const { approval: ended, running: endedJob } = await bashApproval();
    await prisma.fleetJob.update({ where: { id: endedJob.id }, data: { state: 'UPLOADING' } });
    await request(server).post(`${project}/${ended.id}/decide`).set(as(padmin)).send({ decision: 'deny' }).expect(409);
    expect(await entries(ended.id, 'fleet.approval.decide.bash')).toHaveLength(0);

    const { approval: expired } = await bashApproval({ expiresAt: new Date(Date.now() - 1_000) });
    await request(server).post(`${project}/${expired.id}/decide`).set(as(padmin)).send({ decision: 'deny' }).expect(409);
    expect(await entries(expired.id, 'fleet.approval.decide.bash')).toHaveLength(0);
  });
});

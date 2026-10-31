import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { BudgetEvaluator } from '../../../src/fleet/budgets/budget-evaluator';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { seedFleetAsk } from '../../helpers/fleet-ask-fixtures';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

/**
 * Permissions P3 US-007 (fix round 1): the fleet decide route is the engine adapter, so a decision records the
 * engine's `approval.decide` row plus the command's own audit (`fleet.budget.override`, `fleet.job.shell.escalate`),
 * never the retired `fleet.approval.decide.bash` / `.budget` keys.
 */
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
  /** Permissions P3 7c US-008: the engine's decide route, with the fleet vocabulary mapped onto it. */
  const decisions = '/api/approvals';
  const decide = (id: string, token: string, body: Record<string, unknown>) =>
    request(server).post(`${decisions}/${id}/decisions`).set(as(token)).send(body);
  const job = (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: { projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `audit-ap-${++n}`, profiles: [], maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.dev, state: 'COMPLETED', firstStartedAt: new Date(), ...over },
  });
  /** A paused policy with its pending engine ask (`requestId`), the queued job the stop cancelled, and the policy. */
  const startPendingBudget = async (scope: 'project' | 'global' = 'project') => {
    const policy = await prisma.budgetPolicy.create({ data: scope === 'project'
      ? { scopeType: 'project', scopeId: world.projectId, scopeKey: `project:${world.projectId}`, projectId: world.projectId, windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(10), warnPercent: null, createdById: world.ids.root, updatedById: world.ids.root }
      : { scopeType: 'global', scopeKey: 'global', windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(10), warnPercent: null, createdById: world.ids.root, updatedById: world.ids.root } });
    await job({ costSpentUsd: 10 });
    const queued = await job({ state: 'QUEUED', firstStartedAt: null });
    await withTestActor({ type: 'SYSTEM', id: 'budget' }, () => app.get(BudgetEvaluator).evaluate(policy.id));
    const link = await prisma.fleetApprovalAsk.findFirstOrThrow({ where: { budgetPolicyId: policy.id } });
    return { policy, queued, requestId: link.requestId };
  };
  const entries = (resourceId: string, key: string) => prisma.auditEntry.findMany({ where: { resourceId, key } });
  /** A pending bash ask on a running job of this project, as the relay would have opened it. */
  const bashApproval = async (over: { state?: string; expiresAt?: Date } = {}) => {
    const running = await job({ state: over.state ?? 'RUNNING', runnerId: runnerId, leaseEpoch: 1, bashMode: 'escalate' });
    const payload = { command: 'bun test', commandTruncated: false, options: ['allow', 'deny'] };
    const { requestId } = await seedFleetAsk(prisma, {
      kind: 'bash', projectId: world.projectId, onBehalfOf: { type: 'USER', id: world.ids.dev },
      expiresAt: over.expiresAt ?? new Date(Date.now() + 300_000),
      input: { jobId: running.id, leaseEpoch: running.leaseEpoch, naxAskId: `audit-ask-${++n}`, payload },
      link: { jobId: running.id, leaseEpoch: running.leaseEpoch, naxAskId: `audit-ask-${n}` },
    });
    return { running, approvalId: requestId };
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
    await prisma.fleetApprovalAsk.deleteMany();
    await prisma.approvalRequest.deleteMany();
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.outboxEvent.deleteMany();
  });

  it('AC-1/2: records keep-paused with actor, resource, summary and project; global scope is null', async () => {
    const { requestId } = await startPendingBudget();
    // `keep_paused` is the engine's `reject` (permissions P3 7c US-008).
    await decide(requestId, padmin, { decision: 'reject' }).expect(200);
    const [entry] = await entries(requestId, 'approval.decide');
    expect(entry).toMatchObject({
      key: 'approval.decide', resourceType: 'approval-request', resourceId: requestId, actorType: 'USER', actorId: padminId,
      summary: 'rejected fleet.budget.override', projectId: world.projectId,
    });

    const global = await startPendingBudget('global');
    await decide(global.requestId, world.tokens.root, { decision: 'reject' }).expect(200);
    expect(await entries(global.requestId, 'approval.decide')).toHaveLength(1);
    expect((await entries(global.requestId, 'approval.decide'))[0]).toMatchObject({ projectId: null, summary: 'rejected fleet.budget.override' });
  });

  it('AC-3/4: raise-and-resume writes the engine decision, the command entry and the requeued job entry', async () => {
    const { requestId, queued } = await startPendingBudget();
    // `raise_budget_and_resume` is the engine's approve with `{ amountUsd, requeueJobIds }` in `params`.
    await decide(requestId, padmin, { decision: 'approve', params: { amountUsd: 25, requeueJobIds: [queued.id] } }).expect(200);
    expect(await entries(requestId, 'approval.decide')).toMatchObject([{ summary: 'approved fleet.budget.override' }]);
    expect(await entries(requestId, 'fleet.budget.override')).toMatchObject([{ summary: 'raised to 25 and resumed', projectId: world.projectId }]);
    expect(await entries(queued.id, 'fleet.job.requeue')).toHaveLength(1);
    // The retired fleet decide keys no longer audit anything.
    expect(await entries(requestId, 'fleet.approval.decide.budget')).toHaveLength(0);
  });

  it('AC-5/7: a refused repeat and an invisible bash ask record nothing', async () => {
    const { requestId } = await startPendingBudget();
    await decide(requestId, padmin, { decision: 'reject' }).expect(200);
    // The engine's not-pending refusal is `approvals.notPending` (409), not the adapter's error code.
    await decide(requestId, padmin, { decision: 'reject' }).expect(409);
    expect(await entries(requestId, 'approval.decide')).toHaveLength(1);

    const { approvalId: bash } = await bashApproval();
    // The engine answers a request the caller may neither see nor decide as missing (404), not as the adapter's 403.
    await decide(bash, world.tokens.viewer, { decision: 'reject' }).expect(404);
    expect(await entries(bash, 'approval.decide')).toHaveLength(0);
    expect(await entries(bash, 'fleet.job.shell.escalate')).toHaveLength(0);
  });

  it('AC-6/8/9/11: records each decision once; ended and expired asks answer nothing', async () => {
    const { approvalId: valid } = await bashApproval();
    await decide(valid, padmin, { decision: 'reject' }).expect(200);
    expect(await entries(valid, 'approval.decide')).toHaveLength(1);
    expect(await entries(valid, 'fleet.job.shell.escalate')).toMatchObject([{ summary: 'answered deny', projectId: world.projectId }]);
    await decide(valid, padmin, { decision: 'reject' }).expect(409);
    expect(await entries(valid, 'approval.decide')).toHaveLength(1);

    // The engine records the decision (200, the request settles `rejected`), but the job had ended: the command
    // answers nothing, so there is no answer audit and the link says why.
    const { approvalId: ended, running: endedJob } = await bashApproval();
    await prisma.fleetJob.update({ where: { id: endedJob.id }, data: { state: 'UPLOADING' } });
    await decide(ended, padmin, { decision: 'reject' }).expect(200);
    expect(await entries(ended, 'approval.decide')).toHaveLength(1);
    expect(await entries(ended, 'fleet.job.shell.escalate')).toHaveLength(0);
    expect((await prisma.fleetApprovalAsk.findUniqueOrThrow({ where: { requestId: ended } })).resolvedBy).toBe('job_ended');

    // An ask that expired before the decide wrote nothing at all: the decision never reached the engine.
    const { approvalId: expired } = await bashApproval({ expiresAt: new Date(Date.now() - 1_000) });
    await decide(expired, padmin, { decision: 'reject' }).expect(409);
    expect(await entries(expired, 'approval.decide')).toHaveLength(0);
    expect(await entries(expired, 'fleet.job.shell.escalate')).toHaveLength(0);
  });
});

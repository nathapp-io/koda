/**
 * Fleet S1.5 slice 1a — approvals over HTTP: both prefixes, permissions, decide, re-queue, counts, webhooks (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-approvals-api.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { FleetHttpWorld, insertRunner, seedFleetHttpAgent, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { ApprovalsService } from '../../../src/fleet/approvals/approvals.service';
import { BudgetEvaluator } from '../../../src/fleet/budgets/budget-evaluator';
import enFleet from '../../../src/i18n/en/fleet.json';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(30_000);

interface Approval { id: string; status: string; decision: string | null; resolvedBy: string | null; outcome: { resumedAmountUsd?: string; requeueResults?: Array<{ jobId: string; ok: boolean; error?: string }> } | null; requeueCandidates?: Array<{ jobId: string }>; requeueCandidatesTruncated?: boolean }
interface Page<T> { total: number; records: T[] }

/** The two race branches the concurrency cases can legitimately lose to, by i18n key. */
const RACE_CONFLICTS: string[] = [enFleet.approvalNotPending['409'], enFleet.budgetNotPaused['409']];

describeIntegration('fleet approvals API (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let runner: { id: string };
  let evaluator: BudgetEvaluator;
  let approvals: ApprovalsService;
  let padmin: string;
  let n = 0;
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const tok = (who: keyof FleetHttpWorld['tokens']) => as(world.tokens[who]);
  const PROJECT = '/api/projects/web/fleet/approvals';
  const ADMIN = '/api/fleet/approvals';

  const job = (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `ap${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.dev, state: 'COMPLETED', firstStartedAt: new Date(), ...over,
    },
  });
  /** A paused project policy with its pending approval, one queued job the stop cancels, and the approval id. */
  const stopped = async (scope: 'project' | 'global' = 'project') => {
    const policy = await prisma.budgetPolicy.create({
      data: scope === 'project'
        ? { scopeType: 'project', scopeId: world.projectId, scopeKey: `project:${world.projectId}`, projectId: world.projectId, windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(10), warnPercent: null, createdById: world.ids.root, updatedById: world.ids.root }
        : { scopeType: 'global', scopeKey: 'global', windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(10), warnPercent: null, createdById: world.ids.root, updatedById: world.ids.root },
    });
    await job({ costSpentUsd: 10 });
    const queued = await job({ state: 'QUEUED', firstStartedAt: null });
    await evaluator.evaluate(policy.id);
    const approval = await prisma.fleetApproval.findFirstOrThrow({ where: { policyId: policy.id, status: 'pending' } });
    return { policy, queued, approvalId: approval.id };
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    agent = await seedFleetHttpAgent(server, world.tokens.root);
    // S4c US-001: an AgentProject row is the agent's project association.
    await prisma.agentProject.create({ data: { projectId: world.projectId, agentId: agent.id } });
    // Only anchors an already-running bash ask; keep it out of placement for the budget requeue cases.
    runner = await insertRunner(prisma, { createdById: world.ids.root, enabled: false });
    await prisma.ticket.create({ data: {
      projectId: world.projectId, number: 1, type: 'TASK', title: 'Fleet agent work', status: 'IN_PROGRESS',
      assignedToAgentId: agent.id, createdByUserId: world.ids.root,
    } });
    // Prove the key authenticates as this agent and has access through the real project membership guard.
    expect(data<{ id: string }>(await request(server).get('/api/agents/me').set(as(agent.apiKey)).expect(200)).id).toBe(agent.id);
    expect(data<Array<{ id: string }>>(await request(server).get('/api/projects/web/agents').set(as(agent.apiKey)).expect(200))
      .map((a) => a.id)).toContain(agent.id);
    evaluator = app.get(BudgetEvaluator);
    approvals = app.get(ApprovalsService);
    await request(server).post('/api/admin/users').set(tok('root')).send({ email: 'padmin@koda.test', name: 'padmin', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    await request(server).post('/api/projects/web/members').set(tok('root')).send({ email: 'padmin@koda.test', role: 'ADMIN' }).expect(201);
    padmin = await loginToken(server, 'padmin@koda.test');
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
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.outboxEvent.deleteMany();
  });

  it('members list and get; outsiders get 403; candidates on a pending budget approval', async () => {
    const { approvalId, queued } = await stopped();
    const page = data<Page<Approval>>(await request(server).get(PROJECT).set(tok('viewer')).expect(200));
    expect(page.records.map((a) => a.id)).toEqual([approvalId]);
    const one = data<Approval>(await request(server).get(`${PROJECT}/${approvalId}`).set(tok('viewer')).expect(200));
    expect(one.requeueCandidates?.map((c) => c.jobId)).toEqual([queued.id]);
    expect(one.requeueCandidatesTruncated).toBe(false);
    await request(server).get(PROJECT).set(tok('outsider')).expect(403);
    await request(server).get(`/api/projects/ops/fleet/approvals/${approvalId}`).set(tok('root')).expect(404);
  });

  it.each(['list', 'get'] as const)('an authenticated project agent cannot %s approvals', async (endpoint) => {
    const { approvalId } = await stopped();
    const url = endpoint === 'list' ? PROJECT : `${PROJECT}/${approvalId}`;
    await request(server).get(url).set(tok('viewer')).expect(200);
    await request(server).get(url).set(as(agent.apiKey)).expect(403);
  });

  it('an authenticated project agent cannot decide a budget override', async () => {
    const { approvalId, policy, queued } = await stopped();
    const decision = { decision: 'raise_budget_and_resume', amountUsd: 25, requeueJobIds: [queued.id] };
    // Agents have a null project role, so the service also returns 403. Check that the controller's
    // user-only gate rejects before delegation; otherwise deleting that gate could leave this test green.
    const decide = jest.spyOn(approvals, 'decide');
    try {
      await request(server).post(`${PROJECT}/${approvalId}/decide`).set(as(agent.apiKey)).send(decision).expect(403);
      expect(decide).not.toHaveBeenCalled();
    } finally {
      decide.mockRestore();
    }
    expect(await prisma.fleetApproval.findUniqueOrThrow({ where: { id: approvalId } }))
      .toEqual(expect.objectContaining({ status: 'pending', decision: null, decidedById: null }));
    expect((await prisma.budgetPolicy.findUniqueOrThrow({ where: { id: policy.id } })).pausedAt).not.toBeNull();
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: queued.id } })).state).toBe('CANCELLED');
    await request(server).post(`${PROJECT}/${approvalId}/decide`).set(as(padmin)).send(decision).expect(200);
  });

  it('an authenticated project agent cannot decide a bash approval', async () => {
    const running = await job({ state: 'RUNNING', runnerId: runner.id, leaseEpoch: 1, bashMode: 'escalate' });
    const approval = await prisma.fleetApproval.create({ data: {
      type: 'nax_bash_escalate', projectId: world.projectId, jobId: running.id, leaseEpoch: running.leaseEpoch,
      naxAskId: 'agent-guard-ask', requestedAt: new Date(), expiresAt: new Date(Date.now() + 300_000),
      payload: { command: 'bun run test', commandTruncated: false, options: ['allow', 'deny'] },
    } });
    const decide = jest.spyOn(approvals, 'decide');
    try {
      await request(server).post(`${PROJECT}/${approval.id}/decide`).set(as(agent.apiKey)).send({ decision: 'allow' }).expect(403);
      expect(decide).not.toHaveBeenCalled();
    } finally {
      decide.mockRestore();
    }
    expect(await prisma.fleetApproval.findUniqueOrThrow({ where: { id: approval.id } }))
      .toEqual(expect.objectContaining({ status: 'pending', decision: null, decidedById: null }));
    expect(await prisma.fleetCommand.count({ where: { jobId: running.id, type: 'APPROVAL_ANSWER' } })).toBe(0);
    await request(server).post(`${PROJECT}/${approval.id}/decide`).set(tok('dev')).send({ decision: 'allow' }).expect(200);
  });

  it('an authenticated project agent cannot read approval counts', async () => {
    await stopped();
    expect(data<{ total: number }>(await request(server).get('/api/fleet/approval-counts').set(tok('dev')).expect(200)).total).toBe(1);
    await request(server).get('/api/fleet/approval-counts').set(as(agent.apiKey)).expect(403);
  });

  it('a global policy approval is on the admin routes only', async () => {
    const { approvalId } = await stopped('global');
    expect(data<Page<Approval>>(await request(server).get(PROJECT).set(tok('root')).expect(200)).total).toBe(0);
    expect(data<Page<Approval>>(await request(server).get(ADMIN).set(tok('root')).expect(200)).records.map((a) => a.id)).toEqual([approvalId]);
    await request(server).get(ADMIN).set(tok('dev')).expect(403);
  });

  it('a developer cannot decide a budget override; a project admin can keep it paused', async () => {
    const { approvalId, policy } = await stopped();
    await request(server).post(`${PROJECT}/${approvalId}/decide`).set(tok('dev')).send({ decision: 'keep_paused' }).expect(403);
    const decided = data<Approval>(await request(server).post(`${PROJECT}/${approvalId}/decide`).set(as(padmin)).send({ decision: 'keep_paused' }).expect(200));
    expect(decided).toEqual(expect.objectContaining({ status: 'rejected', decision: 'keep_paused', resolvedBy: 'user' }));
    expect((await prisma.budgetPolicy.findUniqueOrThrow({ where: { id: policy.id } })).pausedAt).not.toBeNull();
    const again = await request(server).post(`${PROJECT}/${approvalId}/decide`).set(as(padmin)).send({ decision: 'keep_paused' }).expect(409);
    expect(again.body.message).toBeDefined();
  });

  it('raise and resume lifts the pause and re-queues the selected candidates, including a placement-cancelled job', async () => {
    const { approvalId, policy, queued } = await stopped();
    const later = await job({ state: 'CANCELLED', firstStartedAt: null, startedAt: null, cancelReason: `budget:${policy.id}`, stateReason: `budget:${policy.id}`, finishedAt: new Date(Date.now() + 1_000) });
    // A fractional amount, so `outcome.resumedAmountUsd` is pinned as the DB decimal string and not as
    // the request number: `25.5` in JSON must come back as `'25.5'`, never `'25.5000000'` or `25.5`.
    const decided = data<Approval>(await request(server).post(`${PROJECT}/${approvalId}/decide`).set(as(padmin))
      .send({ decision: 'raise_budget_and_resume', amountUsd: 25.5, requeueJobIds: [queued.id, later.id] }).expect(200));
    expect(decided).toEqual(expect.objectContaining({ status: 'approved', decision: 'raise_budget_and_resume' }));
    expect(decided.outcome?.resumedAmountUsd).toBe('25.5');
    expect(decided.outcome?.requeueResults).toEqual([{ jobId: queued.id, ok: true }, { jobId: later.id, ok: true }]);
    const after = await prisma.budgetPolicy.findUniqueOrThrow({ where: { id: policy.id } });
    expect(after).toEqual(expect.objectContaining({ pausedAt: null, amountUsd: new Prisma.Decimal(25.5) }));
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: queued.id } })).state).toBe('QUEUED');
    expect((await prisma.budgetIncident.findFirstOrThrow({ where: { policyId: policy.id, kind: 'resumed' } })).approvalId).toBe(approvalId);
    expect(await prisma.outboxEvent.count({ where: { payload: { contains: '"event":"fleet.approval.resolved"' } } })).toBe(1);
  });

  it('partial re-queue: an active duplicate fails alone, the resume stands (review focus 2)', async () => {
    const { approvalId, policy, queued } = await stopped();
    await job({ state: 'QUEUED', firstStartedAt: null, feature: queued.feature });
    const decided = data<Approval>(await request(server).post(`${PROJECT}/${approvalId}/decide`).set(as(padmin))
      .send({ decision: 'raise_budget_and_resume', amountUsd: 25, requeueJobIds: [queued.id] }).expect(200));
    expect(decided.status).toBe('approved');
    expect(decided.outcome?.requeueResults).toEqual([{ jobId: queued.id, ok: false, error: expect.any(String) }]);
    // The failed re-queue must not have rolled the resume back: the policy row is the proof, `status`
    // on the approval is only the decision that was already committed.
    expect(await prisma.budgetPolicy.findUniqueOrThrow({ where: { id: policy.id } }))
      .toEqual(expect.objectContaining({ pausedAt: null, amountUsd: new Prisma.Decimal(25) }));
  });

  it('refuses a missing amount, an amount not above spend, and a non-candidate id', async () => {
    const { approvalId } = await stopped();
    await request(server).post(`${PROJECT}/${approvalId}/decide`).set(as(padmin)).send({ decision: 'raise_budget_and_resume' }).expect(400);
    await request(server).post(`${PROJECT}/${approvalId}/decide`).set(as(padmin)).send({ decision: 'raise_budget_and_resume', amountUsd: 5 }).expect(400);
    await request(server).post(`${PROJECT}/${approvalId}/decide`).set(as(padmin)).send({ decision: 'raise_budget_and_resume', amountUsd: 25, requeueJobIds: ['nope'] }).expect(400);
    expect((await prisma.fleetApproval.findUniqueOrThrow({ where: { id: approvalId } })).status).toBe('pending');
  });

  it('admin prefix on a project policy resumes it (review focus 5)', async () => {
    const { approvalId, policy } = await stopped();
    await request(server).post(`${ADMIN}/${approvalId}/decide`).set(tok('root')).send({ decision: 'raise_budget_and_resume', amountUsd: 30 }).expect(200);
    expect((await prisma.budgetPolicy.findUniqueOrThrow({ where: { id: policy.id } })).pausedAt).toBeNull();
  });

  it('decide after the policy was deleted is 409 (review focus 3)', async () => {
    const { approvalId, policy } = await stopped();
    await request(server).delete(`/api/projects/web/fleet/budgets/${policy.id}`).set(as(padmin)).expect(204);
    await request(server).post(`${PROJECT}/${approvalId}/decide`).set(as(padmin)).send({ decision: 'keep_paused' }).expect(409);
    // Review focus 3 also covers the delete's own half: the approval is closed, not left pending or
    // approved, and with no human decision attached, so the later decide fails on state, not on a missing policy.
    const closed = await prisma.fleetApproval.findUniqueOrThrow({ where: { id: approvalId } });
    expect(closed).toEqual(expect.objectContaining({ status: 'cancelled', resolvedBy: 'policy_deleted', decidedById: null }));
  });

  it('concurrent evaluate and decide over HTTP: no deadlock (review focus 1)', async () => {
    const { approvalId, policy } = await stopped();
    // Review focus 1 is the policy -> approval lock nesting (spec §1.4), so `evaluate` has to reach the
    // approval row here. A policy left paused short-circuits at `isEffectivelyPaused` and never opens
    // or closes an approval, so both calls would contend on the policy row alone and prove nothing.
    // Task 4's D228 shape: clear the pause, keep the amount, so the same window spend still hard-stops.
    await prisma.budgetPolicy.update({ where: { id: policy.id }, data: { pausedAt: null, pausedWindowStart: null } });
    const [res] = await Promise.all([
      request(server).post(`${PROJECT}/${approvalId}/decide`).set(as(padmin)).send({ decision: 'raise_budget_and_resume', amountUsd: 40 }),
      evaluator.evaluate(policy.id),
      evaluator.evaluate(policy.id),
    ]);
    // The decide can never win this race to a 200: it holds the policy lock from its first query, so the
    // pause it needs is either already superseded (approval not pending) or the one the test just cleared
    // (budget not paused). Both paths nest policy -> approval, so one commits and the other answers 409;
    // a reversed nesting would deadlock here and surface as a 500 instead.
    expect(res.status).toBe(409);
    // The status alone cannot tell those two apart, so on a slower box this would quietly degrade into a
    // check of the fixture. The message names the branch: a deadlock or any other 409 fails here.
    expect(RACE_CONFLICTS).toContain(res.body.message);
    // Whichever promise took the policy lock first, the stop that got through superseded the pending
    // approval (system close: no human decision) and opened a fresh pending one in its place.
    expect(await prisma.fleetApproval.findUniqueOrThrow({ where: { id: approvalId } }))
      .toEqual(expect.objectContaining({ status: 'cancelled', resolvedBy: 'superseded', decidedById: null }));
    expect(await prisma.fleetApproval.count({ where: { policyId: policy.id, status: 'pending' } })).toBe(1);
    // One hard stop per policy per window (D228): the second `evaluate` sees the pause the first committed.
    expect(await prisma.budgetIncident.count({ where: { policyId: policy.id, kind: 'hard_stop' } })).toBe(1);
  });

  /**
   * Additive to the HTTP case above, which is what exercises the route (ProjectMembershipGuard, the DTO
   * validation pipe, `route(ctx)`/`ctx.role`, `requireUser`) — but it reaches Postgres so much later than
   * the in-process `evaluate` that reversing `decide`'s two lock lines still passes it: ~0% mutant
   * detection. Here both transactions open in one tick, so they really are concurrent on the database.
   *
   * One `decide` and one `evaluate`, deliberately, and only because a second `evaluate` adds no
   * concurrency signal to this pair. The cycle under test is `decide` and this `evaluate` alone:
   * `evaluate` takes the policy lock first and then wants the approval row, while `decide` takes the
   * policy lock first too and then wants the same approval row, so a reversed nesting anywhere in that
   * pair is what has to deadlock.
   *
   * This is a **real but probabilistic** guard, and it is probabilistic purely because there is no
   * barrier: nothing holds either row back until both transactions are in flight, so whether they
   * actually overlap is left to connection scheduling. A green run is evidence, a red run is proof; do
   * not read it as "the lock order is verified". A true barrier (hold the policy row from a third
   * connection, fire, release) would be deterministic, but that is a redesign and is not warranted here.
   *
   * Postgres picks the deadlock victim, so it is not knowable in advance which of the two promises
   * rejects — hence `Promise.allSettled` and the loop over both results rather than an await on one.
   *
   * The regex below matches the error *text*, not an error code, and that is load-bearing: both lock
   * statements are `$queryRaw ... FOR UPDATE`, so a `40P01` raised there reaches the test as Prisma
   * `P2010` (raw query failed), never `P2034` (transaction conflict). Tightening the regex to an error
   * code would stop matching and silently turn this into a test that always passes.
   */
  it('concurrent in-process decide and evaluate: no deadlock, and never a P2034 (review focus 1)', async () => {
    const { approvalId, policy } = await stopped();
    // Same D228 shape as the HTTP case above: clear the pause so `evaluate` reaches the approval row.
    await prisma.budgetPolicy.update({ where: { id: policy.id }, data: { pausedAt: null, pausedWindowStart: null } });
    const [decideResult, evaluateResult] = await Promise.allSettled([
      approvals.decide({ id: world.ids.root, globalAdmin: true }, { kind: 'admin' }, approvalId, { decision: 'raise_budget_and_resume', amountUsd: 40 }),
      evaluator.evaluate(policy.id),
    ]);
    // The only rejection allowed is the decided-conflict, which is the same 409 the HTTP case sees. With a
    // reversed nesting the loser blocks on lock 1 while the winner takes lock 2, the cycle is a deadlock,
    // and Postgres answers `40P01` — which arrives here as Prisma `P2010` on the raw lock query, so the
    // match has to be on that text (see the doc comment).
    for (const r of [decideResult, evaluateResult]) {
      if (r.status === 'rejected') expect(String(r.reason)).not.toMatch(/P2034|40P01|deadlock/i);
    }
    // One interleaving happened, and it is self-consistent: `evaluate` takes the policy lock from its
    // first statement while `decide` still owes one round trip to its own pre-lock read, so the stop
    // supersedes `approvalId` and opens its replacement (one hard stop per policy per window, D228).
    expect(await prisma.fleetApproval.findUniqueOrThrow({ where: { id: approvalId } }))
      .toEqual(expect.objectContaining({ status: 'cancelled', resolvedBy: 'superseded', decidedById: null }));
    expect(await prisma.fleetApproval.count({ where: { policyId: policy.id, status: 'pending' } })).toBe(1);
    expect(await prisma.budgetIncident.count({ where: { policyId: policy.id, kind: 'hard_stop' } })).toBe(1);
  });

  it('counts pending over memberships; unscoped for a global admin only', async () => {
    await stopped();
    await stopped('global');
    const forDev = data<{ total: number; unscoped: number; projects: Array<{ slug: string; pending: number }> }>(
      await request(server).get('/api/fleet/approval-counts').set(tok('dev')).expect(200));
    expect(forDev).toEqual({ total: 1, unscoped: 0, projects: [expect.objectContaining({ slug: 'web', pending: 1 })] });
    const forRoot = data<{ total: number; unscoped: number }>(await request(server).get('/api/fleet/approval-counts').set(tok('root')).expect(200));
    expect(forRoot.unscoped).toBe(1);
    expect(data<{ total: number }>(await request(server).get('/api/fleet/approval-counts').set(tok('outsider')).expect(200)).total).toBe(0);
  });
});

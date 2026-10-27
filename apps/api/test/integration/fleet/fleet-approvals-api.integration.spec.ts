import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet S1.5 slice 1a — approvals over HTTP: both prefixes, permissions, decide, re-queue, counts, webhooks (PG).
 *
 * Permissions P3 (US-007 fix round 1): the list, get, decide and counts routes read the approval engine
 * (`ApprovalRequest` + `FleetApprovalAsk`), so every case below seeds with `seedFleetAsk` and asserts on the engine
 * request and its link.
 *
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-approvals-api.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { FleetHttpWorld, insertRunner, rosterFleetAgent, seedFleetHttpAgent, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { ApprovalsService } from '../../../src/fleet/approvals/approvals.service';
import { BudgetEvaluator } from '../../../src/fleet/budgets/budget-evaluator';
import { expectBindingOnlyFixtures } from '../../../src/permissions/test-helpers/permission-fixtures';
import enFleet from '../../../src/i18n/en/fleet.json';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';
import { seedFleetAsk, type SeedFleetAskSpec } from '../../helpers/fleet-ask-fixtures';
import { outboxRecord } from '../../helpers/outbox-record';
import { FanOutPublisher } from '../../../src/outbox/fan-out-publisher';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

vi.setConfig({ testTimeout: 30_000 });

interface Approval { id: string; type: string; status: string; jobId: string | null; decision: string | null; resolvedBy: string | null; outcome: { resumedAmountUsd?: string; requeueResults?: Array<{ jobId: string; ok: boolean; error?: string }> } | null; requeueCandidates?: Array<{ jobId: string }>; requeueCandidatesTruncated?: boolean }
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
  let padminId: string;
  let publisher: FanOutPublisher;
  let n = 0;
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const tok = (who: keyof FleetHttpWorld['tokens']) => as(world.tokens[who]);
  /** The root user as the API authenticates it: a global ADMIN principal. */
  const rootPrincipal = () => ({
    actorType: 'user' as const, id: world.ids.root, role: 'ADMIN' as const, email: 'root@koda.test',
    name: 'Root', blacklisted: false, revoked: false, authorities: [],
  });
  /** One evaluation as the budget sweeper runs it: the wrapped entry production reaches `evaluate` from. */
  const evaluate = (policyId: string) => withTestActor({ type: 'SYSTEM', id: 'budget' }, () => evaluator.evaluate(policyId));
  /**
   * Runs the outbox relay over the pending events of one type. The fleet's decision outputs are recorded from
   * `approval_request_changed` (US-009 / fix round 2), so a test that asserts them has to deliver the event.
   */
  const deliver = async (type: string): Promise<void> => {
    for (const row of await prisma.outboxEvent.findMany({ where: { type }, orderBy: { createdAt: 'asc' } })) {
      await publisher.publish(outboxRecord(row.type, JSON.parse(row.payload), {
        id: row.id, metadata: { projectId: row.projectId, eventId: row.eventId },
      }));
    }
  };
  const PROJECT = '/api/projects/web/fleet/approvals';
  const ADMIN = '/api/fleet/approvals';

  const job = (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `ap${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.dev, state: 'COMPLETED', firstStartedAt: new Date(), ...over,
    },
  });
  /** The policy's pending budget asks as engine request ids, oldest first. */
  const policyAsks = (policyId: string) => prisma.fleetApprovalAsk.findMany({ where: { budgetPolicyId: policyId }, orderBy: { requestId: 'asc' } });
  const pendingPolicyAsks = async (policyId: string): Promise<number> => {
    const links = await policyAsks(policyId);
    if (links.length === 0) return 0;
    return prisma.approvalRequest.count({ where: { id: { in: links.map((l) => l.requestId) }, status: 'pending' } });
  };
  /** A paused project policy with its pending ask, one queued job the stop cancels, and the request id. */
  const stopped = async (scope: 'project' | 'global' = 'project') => {
    const policy = await prisma.budgetPolicy.create({
      data: scope === 'project'
        ? { scopeType: 'project', scopeId: world.projectId, scopeKey: `project:${world.projectId}`, projectId: world.projectId, windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(10), warnPercent: null, createdById: world.ids.root, updatedById: world.ids.root }
        : { scopeType: 'global', scopeKey: 'global', windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(10), warnPercent: null, createdById: world.ids.root, updatedById: world.ids.root },
    });
    await job({ costSpentUsd: 10 });
    const queued = await job({ state: 'QUEUED', firstStartedAt: null });
    await evaluate(policy.id);
    const [link] = await policyAsks(policy.id);
    return { policy, queued, approvalId: link.requestId };
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    agent = await seedFleetHttpAgent(server, world.tokens.root);
    // S4c US-001: the agent's project association is a role binding in the project.
    await rosterFleetAgent(prisma, agent.id, world.projectId);
    // Only anchors an already-running bash ask; keep it out of placement for the budget requeue cases.
    runner = await insertRunner(prisma, { createdById: world.ids.root, enabled: false });
    await prisma.ticket.create({ data: {
      projectId: world.projectId, number: 1, type: 'TASK', title: 'Fleet agent work', status: 'IN_PROGRESS',
      assignedToAgentId: agent.id, createdByUserId: world.ids.root,
    } });
    // Prove the key authenticates as this agent and has access through the real project membership guard.
    expect(data<{ id: string }>(await request(server).get('/api/agents/me').set(as(agent.apiKey)).expect(200)).id).toBe(agent.id);
    expect(data<{ items: { id?: string; slug: string }[] }>(
      await request(server).get('/api/projects/web/agents').set(as(agent.apiKey)).expect(200),
    ).items.map((a) => a.slug)).toContain(agent.slug);
    evaluator = app.get(BudgetEvaluator);
    approvals = app.get(ApprovalsService);
    publisher = app.get(FanOutPublisher);
    await request(server).post('/api/admin/users').set(tok('root')).send({ email: 'padmin@koda.test', name: 'padmin', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    await request(server).post('/api/projects/web/members').set(tok('root')).send({ email: 'padmin@koda.test', roleKey: 'project-admin' }).expect(201);
    padmin = await loginToken(server, 'padmin@koda.test');
    padminId = (await prisma.user.findUniqueOrThrow({ where: { email: 'padmin@koda.test' } })).id;
    await prisma.webhook.create({
      data: { projectId: world.projectId, url: 'https://hooks.example.com/koda', secret: 's'.repeat(32), events: JSON.stringify(['fleet.approval.requested', 'fleet.approval.resolved']) },
    });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.budgetPolicy.deleteMany();
    await prisma.fleetApprovalAsk.deleteMany();
    await prisma.approvalRequest.deleteMany();
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.outboxEvent.deleteMany();
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('fixtures grant through bindings only', async () => {
    await expectBindingOnlyFixtures(prisma, [
      { type: 'USER', id: world.ids.root },
      { type: 'USER', id: world.ids.dev },
      { type: 'USER', id: world.ids.viewer },
      { type: 'USER', id: world.ids.outsider },
      { type: 'USER', id: padminId },
      { type: 'AGENT', id: agent.id },
    ]);
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

  it.each(['list', 'get'] as const)('an authenticated project agent reads approvals (%s)', async (endpoint) => {
    const { approvalId } = await stopped();
    const url = endpoint === 'list' ? PROJECT : `${PROJECT}/${approvalId}`;
    await request(server).get(url).set(tok('viewer')).expect(200);
    // Permissions P1d US-006 (R10 retired for approvals): the agent's project bindings (the roster's
    // viewer reach and its agent roles) hold `fleet.approval.read` in this project, so the route key admits it
    // like a member.
    const res = await request(server).get(url).set(as(agent.apiKey)).expect(200);
    if (endpoint === 'get') expect(data<Approval>(res).id).toBe(approvalId);
  });

  it('an authenticated project agent cannot decide a budget override', async () => {
    const { approvalId, policy, queued } = await stopped();
    const decision = { decision: 'raise_budget_and_resume', amountUsd: 25, requeueJobIds: [queued.id] };
    // The refusal is the engine's eligibility check (the agent holds neither `fleet.budget.override` nor
    // `approval.decide@fleet.budget.override` in the project), answered before the body is validated, so the ask
    // keeps its state.
    await request(server).post(`${PROJECT}/${approvalId}/decide`).set(as(agent.apiKey)).send(decision).expect(403);
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } })).status).toBe('pending');
    expect((await prisma.fleetApprovalAsk.findUniqueOrThrow({ where: { requestId: approvalId } })).resolvedBy).toBeNull();
    expect((await prisma.budgetPolicy.findUniqueOrThrow({ where: { id: policy.id } })).pausedAt).not.toBeNull();
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: queued.id } })).state).toBe('CANCELLED');
    await request(server).post(`${PROJECT}/${approvalId}/decide`).set(as(padmin)).send(decision).expect(200);
  });

  it('an authenticated project agent allows a bash approval of a user\'s job', async () => {
    const running = await job({ state: 'RUNNING', runnerId: runner.id, leaseEpoch: 1, bashMode: 'escalate' });
    const { requestId } = await seedFleetAsk(prisma, {
      kind: 'bash', projectId: world.projectId, onBehalfOf: { type: 'USER', id: world.ids.dev }, expiresAt: new Date(Date.now() + 300_000),
      input: { jobId: running.id, leaseEpoch: running.leaseEpoch, naxAskId: 'agent-guard-ask', payload: { command: 'bun run test', commandTruncated: false, options: ['allow', 'deny'] } },
      link: { jobId: running.id, leaseEpoch: running.leaseEpoch, naxAskId: 'agent-guard-ask' },
    });
    await request(server).post(`${PROJECT}/${requestId}/decide`).set(as(agent.apiKey)).send({ decision: 'allow' }).expect(200);
    // The engine ran the bash command: the request executed and the answer is queued for the job's runner.
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: requestId } })).status).toBe('executed');
    expect(await prisma.fleetCommand.count({ where: { jobId: running.id, type: 'APPROVAL_ANSWER' } })).toBe(1);
  });

  it('an authenticated project agent reads approval counts', async () => {
    await stopped();
    expect(data<{ total: number }>(await request(server).get('/api/fleet/approval-counts').set(tok('dev')).expect(200)).total).toBe(1);
    // US-006: `projectIdsWithKey` gives the rostered agent its project, so it counts what it may read.
    expect(data<{ total: number; projects: Array<{ slug: string; pending: number }> }>(
      await request(server).get('/api/fleet/approval-counts').set(as(agent.apiKey)).expect(200)))
      .toEqual(expect.objectContaining({ total: 1, projects: [expect.objectContaining({ slug: 'web', pending: 1 })] }));
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
    // The resumed incident still names the ask it answered: the close answers the request id.
    expect((await prisma.budgetIncident.findFirstOrThrow({ where: { policyId: policy.id, kind: 'resumed' } })).approvalId).toBe(approvalId);
    // The decision's fleet outputs come from the durable outbox event (permissions P3 US-009).
    await deliver('approval_request_changed');
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
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } })).status).toBe('pending');
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
    // Review focus 3 also covers the delete's own half: the ask is closed, not left pending or approved, and with no
    // human decision attached, so the later decide fails on state, not on a missing policy.
    expect(await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } }))
      .toEqual(expect.objectContaining({ status: 'cancelled', result: { closedBy: 'policy_deleted' }, approverId: null }));
    expect((await prisma.fleetApprovalAsk.findUniqueOrThrow({ where: { requestId: approvalId } })).resolvedBy).toBe('policy_deleted');
  });

  /**
   * Review focus 1 is the policy -> request lock nesting: `evaluate` takes the budget policy first and then the ask
   * rows, while the engine's decide takes the request first and its command takes the policy. The fleet side reads
   * the ask with `FOR UPDATE SKIP LOCKED`, so the two orders cannot form a cycle; what this pins is that they do not
   * (a deadlock surfaces as a 500) and that whichever interleaving happened leaves a state the fleet can explain:
   * a paused policy has exactly one pending ask, and an unpaused one has none.
   */
  it('concurrent evaluate and decide over HTTP: no deadlock (review focus 1)', async () => {
    const { approvalId, policy } = await stopped();
    // A policy left paused short-circuits at `isEffectivelyPaused` and never opens or closes an ask, so the pause is
    // cleared (D228 shape: same amount, same window spend) for `evaluate` to reach the ask rows at all.
    await prisma.budgetPolicy.update({ where: { id: policy.id }, data: { pausedAt: null, pausedWindowStart: null } });
    const [res] = await Promise.all([
      request(server).post(`${PROJECT}/${approvalId}/decide`).set(as(padmin)).send({ decision: 'raise_budget_and_resume', amountUsd: 40 }),
      evaluate(policy.id),
      evaluate(policy.id),
    ]);

    // Either the decide resumed the policy between the two stops (200) or a stop superseded its ask first (409); a
    // deadlock or any other failure would be a 500 here.
    expect([200, 409]).toContain(res.status);
    if (res.status === 409) expect(RACE_CONFLICTS).toContain(res.body.message);
    const paused = (await prisma.budgetPolicy.findUniqueOrThrow({ where: { id: policy.id } })).pausedAt;
    expect(await pendingPolicyAsks(policy.id)).toBe(paused === null ? 0 : 1);
    // One hard stop per policy per window (D228): the second `evaluate` sees the pause the first committed.
    expect(await prisma.budgetIncident.count({ where: { policyId: policy.id, kind: 'hard_stop' } })).toBe(1);
  });

  /**
   * Additive to the HTTP case above, which is what exercises the route (ProjectMembershipGuard, the DTO validation
   * pipe, `route(ctx)`/`ctx.role`, `requireUser`) — but it reaches Postgres so much later than the in-process
   * `evaluate` that reversing the lock order still passes it: ~0% mutant detection. Here both transactions open in one
   * tick, so they really are concurrent on the database.
   *
   * This is a **real but probabilistic** guard: nothing holds either row back until both transactions are in flight,
   * so whether they actually overlap is left to connection scheduling. A green run is evidence, a red run is proof;
   * do not read it as "the lock order is verified".
   *
   * The regex below matches the error *text*, not an error code, and that is load-bearing: both lock statements are
   * `$queryRaw ... FOR UPDATE`, so a `40P01` raised there reaches the test as Prisma `P2010` (raw query failed), never
   * `P2034` (transaction conflict). Tightening the regex to an error code would stop matching and silently turn this
   * into a test that always passes.
   */
  it('concurrent in-process decide and evaluate: no deadlock, and never a P2034 (review focus 1)', async () => {
    const { approvalId, policy } = await stopped();
    // Same D228 shape as the HTTP case above: clear the pause so `evaluate` reaches the ask rows.
    await prisma.budgetPolicy.update({ where: { id: policy.id }, data: { pausedAt: null, pausedWindowStart: null } });
    const [decideResult, evaluateResult] = await Promise.allSettled([
      // The in-process `decide` stands in for the admin route, so it runs as the admin who decides.
      withTestActor({ type: 'USER', id: world.ids.root }, () =>
        approvals.decide({ id: world.ids.root, principal: rootPrincipal() }, { kind: 'admin' }, approvalId, { decision: 'raise_budget_and_resume', amountUsd: 40 })),
      evaluate(policy.id),
    ]);
    // The only rejection allowed is a fleet conflict (the ask was already superseded, or the policy already resumed).
    for (const r of [decideResult, evaluateResult]) {
      if (r.status === 'rejected') expect(String(r.reason)).not.toMatch(/P2034|40P01|deadlock/i);
    }
    const paused = (await prisma.budgetPolicy.findUniqueOrThrow({ where: { id: policy.id } })).pausedAt;
    expect(await pendingPolicyAsks(policy.id)).toBe(paused === null ? 0 : 1);
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

  /**
   * Permissions P3 US-011: the list, the detail page and the counts read the approval engine, so every case below
   * seeds with `seedFleetAsk` and reads the engine request id back out of the fleet DTO.
   */
  const bashAsk = (jobId: string, over: Partial<SeedFleetAskSpec> = {}) => {
    const naxAskId = over.link?.naxAskId ?? `ask-api-${++n}`;
    return seedFleetAsk(prisma, {
      kind: 'bash', projectId: world.projectId, expiresAt: new Date(Date.now() + 300_000),
      input: { jobId, leaseEpoch: 1, naxAskId, payload: { command: 'bun run test', commandTruncated: false, options: ['allow', 'deny'] } },
      link: { jobId, leaseEpoch: 1, naxAskId },
      ...over,
    });
  };

  it('US-011 AC-1: lists a seeded pending bash ask as its request row, with the link\'s job', async () => {
    const running = await job({ state: 'RUNNING', runnerId: runner.id, leaseEpoch: 1, bashMode: 'escalate' });
    const { requestId } = await bashAsk(running.id);

    const page = data<Page<Approval>>(await request(server).get(PROJECT).set(tok('viewer')).expect(200));

    expect(page.records).toEqual([
      expect.objectContaining({ id: requestId, type: 'nax_bash_escalate', status: 'pending', jobId: running.id }),
    ]);
  });

  it('US-011 AC-2: as an admin, status=approved answers the executed bash ask and not the rejected one', async () => {
    const running = await job({ state: 'RUNNING', runnerId: runner.id, leaseEpoch: 1 });
    const executed = await bashAsk(running.id, {
      status: 'executed', settledAt: new Date(),
      decisions: [{ deciderType: 'USER', deciderId: world.ids.root, decision: 'approve', params: { choice: 'allow' } }],
    });
    const rejected = await bashAsk(running.id, {
      status: 'rejected',
      decisions: [{ deciderType: 'USER', deciderId: world.ids.root, decision: 'reject' }],
    });

    const page = data<Page<Approval>>(await request(server).get(`${ADMIN}?status=approved`).set(tok('root')).expect(200));

    expect(page.records.map((a) => a.id)).toEqual([executed.requestId]);
    expect(page.records.map((a) => a.id)).not.toContain(rejected.requestId);
  });

  it('US-011 AC-3: a pending budget ask includes its one re-queue candidate, untruncated', async () => {
    const { approvalId, queued } = await stopped();

    const one = data<Approval>(await request(server).get(`${PROJECT}/${approvalId}`).set(tok('viewer')).expect(200));

    expect(one.requeueCandidates?.map((c) => c.jobId)).toEqual([queued.id]);
    expect(one.requeueCandidatesTruncated).toBe(false);
  });

  it("US-011 AC-4: another project's ask is a 404 naming fleet.approvals", async () => {
    const running = await job({ state: 'RUNNING' });
    const { requestId } = await bashAsk(running.id);

    const res = await request(server).get(`/api/projects/ops/fleet/approvals/${requestId}`).set(tok('root')).expect(404);

    expect(res.body.message).toBe(enFleet.approvals['404']);
  });

  it('US-011 AC-5: an admin counts one pending ask in each of two projects', async () => {
    const web = await bashAsk('job-counts-web', { link: { jobId: 'job-counts-web', leaseEpoch: 1, naxAskId: 'ask-counts-web' } });
    const ops = await seedFleetAsk(prisma, {
      kind: 'bash', projectId: world.opsProjectId,
      input: { jobId: 'job-counts-ops', leaseEpoch: 1, naxAskId: 'ask-counts-ops', payload: { command: 'ls', commandTruncated: false, options: ['allow'] } },
      link: { jobId: 'job-counts-ops', leaseEpoch: 1, naxAskId: 'ask-counts-ops' },
    });

    const counts = data<{ total: number; unscoped: number; projects: Array<{ projectId: string; slug: string; pending: number }> }>(
      await request(server).get('/api/fleet/approval-counts').set(tok('root')).expect(200));

    expect(counts.total).toBe(2);
    expect(counts.projects).toEqual([
      { projectId: world.opsProjectId, slug: 'ops', pending: 1 },
      { projectId: world.projectId, slug: 'web', pending: 1 },
    ]);
    expect(web.requestId).not.toBe(ops.requestId);
  });
});

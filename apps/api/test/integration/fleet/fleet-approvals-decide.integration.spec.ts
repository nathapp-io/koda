import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Permissions P3 7c US-008 — the fleet asks decided through the approval engine's route (PG).
 *
 * Permissions P3 US-010 wrote these cases against the fleet adapter (`/projects/:slug/fleet/approvals/:id/decide`),
 * whose contract was "who may decide, before what they sent": a decided ask was 409, an unauthorised caller 403
 * whatever the body says, and only then did the fleet's offer rules answer before `ApprovalDecisionService` settled
 * the request. US-008 re-points every case at `POST /api/approvals/:id/decisions`, the route that survives US-010, so
 * the fleet decision vocabulary is the engine's: `allow` / `allow_for_job` are `{ decision: 'approve', params: { choice } }`,
 * `deny` and `keep_paused` are `{ decision: 'reject' }`, and `raise_budget_and_resume` is
 * `{ decision: 'approve', params: { amountUsd, requeueJobIds } }`.
 *
 * A case whose only assertion was the adapter's own translation is deleted rather than re-pointed: the fleet error
 * prefixes (`fleet.approvalNotPending`, `fleet.approvalSelfDecide`, `fleet.approvalInput`,
 * `fleet.approvalDecisionInvalid`), the adapter's field allow-list on a bash ask, and its "eligibility before the body"
 * ordering. Where the engine answers differently the expectation follows the engine, and the state assertions the
 * adapter cases carried (pause lifted, jobs re-queued, candidate refusals recorded, ended asks answered nothing) are
 * kept.
 *
 * The asks are seeded as the relay and the budget evaluator open them (`seedFleetAsk`; the evaluator for the budget
 * ones), so the row the engine reads is the row production writes.
 *
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-approvals-decide.integration.spec.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { BudgetEvaluator } from '../../../src/fleet/budgets/budget-evaluator';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { FleetHttpWorld, insertRunner, rosterFleetAgent, seedFleetHttpAgent, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { seedFleetAsk } from '../../helpers/fleet-ask-fixtures';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

/** A refusal sentence exactly as `src/i18n/en/<namespace>.json` declares it, with its `{args}` filled in. */
function sentence(key: string, args: Record<string, unknown> = {}): string {
  const [namespace, ...segments] = key.split('.');
  const catalog = JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en', `${namespace}.json`), 'utf8')) as Record<string, unknown>;
  const value = segments.reduce<unknown>(
    (node, segment) => (typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[segment] : undefined),
    catalog,
  );
  if (typeof value !== 'string') throw new Error(`no sentence for ${key}`);
  return value.replace(/\{(\w+)\}/g, (placeholder, name: string) => (name in args ? String(args[name]) : placeholder));
}

/** `REQUEST_PARAMETER_ERROR`: the code every `ValidationAppException` answers with. */
const VALIDATION = -2;

describeIntegration('fleet approvals decide through the engine route (PG, US-008)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let runner: { id: string };
  let evaluator: BudgetEvaluator;
  let padmin: string;
  let padminId: string;
  let n = 0;
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const tok = (who: keyof FleetHttpWorld['tokens']) => as(world.tokens[who]);
  /** The engine's decide route: one route for a project ask and a global one alike. */
  const DECISIONS = '/api/approvals';
  const decide = (id: string, token: string, body: Record<string, unknown>) =>
    request(server).post(`${DECISIONS}/${id}/decisions`).set(as(token)).send(body);
  const view = (id: string, token: string) => request(server).get(`${DECISIONS}/${id}`).set(as(token));
  /** One evaluation as the budget sweeper runs it: the wrapped entry production reaches `evaluate` from. */
  const evaluate = (policyId: string) => withTestActor({ type: 'SYSTEM', id: 'budget' }, () => evaluator.evaluate(policyId));
  const requestOf = (id: string) => prisma.approvalRequest.findUniqueOrThrow({ where: { id } });
  const linkOf = (id: string) => prisma.fleetApprovalAsk.findUniqueOrThrow({ where: { requestId: id } });

  const job = (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `decide${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.dev, state: 'COMPLETED', firstStartedAt: new Date(), ...over,
    },
  });

  /**
   * A pending bash ask on a job of this project, seeded exactly as the relay opens one: the frozen input is
   * nax's ask, the link carries the job, the lease and the ask id.
   */
  const bashAsk = async (over: {
    jobState?: string; requestedBy?: { type: 'USER' | 'AGENT'; id: string }; options?: string[]; commandTruncated?: boolean;
    status?: 'pending' | 'rejected'; decisions?: Array<{ deciderType: 'USER' | 'AGENT'; deciderId: string; decision: 'approve' | 'reject' }>;
  } = {}) => {
    const requestedBy = over.requestedBy ?? { type: 'USER' as const, id: world.ids.dev };
    const running = await job({
      requestedById: requestedBy.id, requestedByType: requestedBy.type, bashMode: 'escalate',
      state: over.jobState ?? 'RUNNING', ...(over.jobState === 'COMPLETED' ? {} : { runnerId: runner.id, leaseEpoch: 1 }),
    });
    const naxAskId = `decide-ask-${++n}`;
    const { requestId } = await seedFleetAsk(prisma, {
      kind: 'bash', projectId: world.projectId, onBehalfOf: requestedBy,
      status: over.status, decisions: over.decisions, expiresAt: new Date(Date.now() + 300_000),
      input: {
        jobId: running.id, leaseEpoch: 1, naxAskId,
        payload: { command: 'bun run test', commandTruncated: over.commandTruncated ?? false, options: over.options ?? ['allow', 'deny'] },
      },
      link: { jobId: running.id, leaseEpoch: 1, naxAskId },
    });
    return { job: running, requestId };
  };

  /**
   * A paused project policy with the budget ask the evaluator opened for it, plus the queued job its hard stop
   * cancelled (the one re-queue candidate). `paused: false` clears the pause the stop wrote, which is the shape
   * a decide finds when the budgets page resumed the policy while the ask was still pending.
   */
  const budgetAsk = async (over: { paused?: boolean } = {}) => {
    const policy = await prisma.budgetPolicy.create({
      data: {
        scopeType: 'project', scopeId: world.projectId, scopeKey: `project:${world.projectId}`, projectId: world.projectId,
        windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(10), warnPercent: null,
        createdById: world.ids.root, updatedById: world.ids.root,
      },
    });
    await job({ costSpentUsd: 10 });
    const queued = await job({ state: 'QUEUED', firstStartedAt: null });
    await evaluate(policy.id);
    const link = await prisma.fleetApprovalAsk.findFirstOrThrow({ where: { budgetPolicyId: policy.id } });
    if (over.paused === false) {
      await prisma.budgetPolicy.update({ where: { id: policy.id }, data: { pausedAt: null, pausedWindowStart: null } });
    }
    return { policy, queued, requestId: link.requestId };
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    agent = await seedFleetHttpAgent(server, world.tokens.root);
    // S4c US-001: the agent's project association is a role binding in the project (a Developer-like reach).
    await rosterFleetAgent(prisma, agent.id, world.projectId);
    runner = await insertRunner(prisma, { createdById: world.ids.root, enabled: false });
    evaluator = app.get(BudgetEvaluator);
    await request(server).post('/api/admin/users').set(tok('root'))
      .send({ email: 'decide-admin@koda.test', name: 'decide admin', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    await request(server).post('/api/projects/web/members').set(tok('root'))
      .send({ email: 'decide-admin@koda.test', roleKey: 'project-admin' }).expect(201);
    padmin = await loginToken(server, 'decide-admin@koda.test');
    padminId = (await prisma.user.findUniqueOrThrow({ where: { email: 'decide-admin@koda.test' } })).id;
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.budgetIncident.deleteMany();
    await prisma.budgetPolicy.deleteMany();
    await prisma.fleetApprovalAsk.deleteMany();
    await prisma.approvalRequest.deleteMany();
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.outboxEvent.deleteMany();
  });

  it('a decision on an already rejected ask is 409 approvals.notPending', async () => {
    const { requestId } = await bashAsk({
      status: 'rejected', decisions: [{ deciderType: 'USER', deciderId: padminId, decision: 'reject' }],
    });

    const res = await decide(requestId, padmin, { decision: 'reject' }).expect(409);

    expect(res.body).toEqual({ ret: 409, message: sentence('approvals.notPending.409', { status: 'rejected' }) });
    // The state refusal came first: the pending check alone decides, so no second decision row exists.
    expect(await prisma.approvalDecision.count({ where: { requestId } })).toBe(1);
    expect(await requestOf(requestId)).toMatchObject({ status: 'rejected' });
  });

  it('AC-2: approving a pending budget ask with params {} and no amount is 400 and the ask stays pending', async () => {
    const { requestId, policy } = await budgetAsk();

    const res = await decide(requestId, padmin, { decision: 'approve', params: {} }).expect(400);

    expect(res.body).toEqual({
      ret: VALIDATION, message: sentence('approvals.invalidDecisionParams.-2', { reason: 'invalid' }),
    });
    // The engine validates the decision params before it records anything, so nothing settled and nothing ran.
    expect(await requestOf(requestId)).toMatchObject({ status: 'pending', approverId: null });
    expect(await prisma.approvalDecision.count({ where: { requestId } })).toBe(0);
    expect((await linkOf(requestId)).resolvedBy).toBeNull();
    expect((await prisma.budgetPolicy.findUniqueOrThrow({ where: { id: policy.id } })).pausedAt).not.toBeNull();
  });

  it('an agent deciding the ask of the job it requested is 403 approvals.decideForbidden for a low tier', async () => {
    const { requestId } = await bashAsk({ requestedBy: { type: 'AGENT', id: agent.id } });

    // The engine's `tier-too-low` (an agent contributes only `self` to an `agent` default) refuses the ask's own
    // agent. US-008: the engine's own refusal, not the adapter's `fleet.approvalSelfDecide` code.
    const res = await decide(requestId, agent.apiKey, { decision: 'approve', params: { choice: 'allow' } }).expect(403);

    expect(res.body).toEqual({
      ret: 403, message: sentence('approvals.decideForbidden.403', { reason: 'tier-too-low' }),
    });
    expect(await requestOf(requestId)).toMatchObject({ status: 'pending', approverId: null });
  });

  it('approving an ask whose command was truncated is 400 and it stays pending (US-010 AC-5)', async () => {
    const { requestId, job: unanswered } = await bashAsk({ commandTruncated: true });

    const res = await decide(requestId, world.tokens.dev, { decision: 'approve', params: { choice: 'allow' } }).expect(400);

    expect(res.body).toEqual({
      ret: VALIDATION, message: sentence('approvals.invalidDecisionParams.-2', { reason: 'invalid' }),
    });
    expect(await requestOf(requestId)).toMatchObject({ status: 'pending', approverId: null });
    // A refused decide writes nothing at all: no decision row, no answer for the runner.
    expect(await prisma.approvalDecision.count({ where: { requestId } })).toBe(0);
    expect(await prisma.fleetCommand.count({ where: { jobId: unanswered.id } })).toBe(0);
  });

  it('allowing a running job’s ask approves it and answers the runner once (US-010 AC-6)', async () => {
    const { requestId, job: running } = await bashAsk();

    const decided = data<Approval>(
      await decide(requestId, world.tokens.dev, { decision: 'approve', params: { choice: 'allow' } }).expect(200),
    );

    // The engine executes the command in the deciding call, so the request it answers is `executed`, not `approved`.
    expect(decided).toEqual(expect.objectContaining({
      id: requestId, permissionKey: 'fleet.job.shell.escalate', status: 'executed', approverType: 'USER', approverId: world.ids.dev,
    }));
    expect(decided.decisions).toEqual([expect.objectContaining({ decision: 'approve', params: { choice: 'allow', option: 'allow' } })]);
    expect(await requestOf(requestId)).toMatchObject({ status: 'executed', approverType: 'USER', approverId: world.ids.dev });
    const commands = await prisma.fleetCommand.findMany({ where: { jobId: running.id, type: 'APPROVAL_ANSWER' } });
    expect(commands).toHaveLength(1);
    // The answer names the request it resolves and the option nax offered.
    expect(commands[0].payload).toEqual(expect.objectContaining({ approvalId: requestId, choice: 'allow' }));
  });

  it('denying a running job’s ask rejects it (US-010 AC-7)', async () => {
    const { requestId } = await bashAsk();

    const decided = data<Approval>(await decide(requestId, world.tokens.dev, { decision: 'reject' }).expect(200));

    expect(decided).toEqual(expect.objectContaining({ id: requestId, status: 'rejected' }));
    expect(decided.decisions).toEqual([expect.objectContaining({ decision: 'reject' })]);
    expect(await requestOf(requestId)).toMatchObject({ status: 'rejected' });
  });

  it('allowing the ask of a completed job answers 200 and records the job-end resolution (US-010 AC-8)', async () => {
    const { requestId, job: ended } = await bashAsk({ jobState: 'COMPLETED' });

    // The command finds the job ended and answers nothing. The engine records the decision and settles the request;
    // the adapter used to turn this into its own 409 after the fact.
    const decided = data<Approval>(
      await decide(requestId, world.tokens.dev, { decision: 'approve', params: { choice: 'allow' } }).expect(200),
    );

    expect(decided).toEqual(expect.objectContaining({ id: requestId, status: 'executed' }));
    expect(decided.result).toEqual({ answered: false });
    expect((await linkOf(requestId)).resolvedBy).toBe('job_ended');
    expect(await prisma.fleetCommand.count({ where: { jobId: ended.id } })).toBe(0);
  });

  it('denying the ask of a completed job rejects it and records the job-end resolution (US-010 AC-9)', async () => {
    const { requestId } = await bashAsk({ jobState: 'COMPLETED' });

    const decided = data<Approval>(await decide(requestId, world.tokens.dev, { decision: 'reject' }).expect(200));

    expect(decided).toEqual(expect.objectContaining({ id: requestId, status: 'rejected' }));
    expect((await linkOf(requestId)).resolvedBy).toBe('job_ended');
  });

  it('raising with an id that is not a re-queue candidate records the engine’s refusal', async () => {
    const { requestId, policy } = await budgetAsk();

    // The engine has no candidate pre-check: it records the raise and reports the refused id in the ask's outcome,
    // instead of the adapter's 400.
    const decided = data<Approval>(await decide(requestId, world.tokens.root, {
      decision: 'approve', params: { amountUsd: 20, requeueJobIds: ['not-a-job'] },
    }).expect(200));

    expect(decided).toEqual(expect.objectContaining({ id: requestId, status: 'executed' }));
    expect(decided.result).toEqual({ resumedAmountUsd: '20' });
    // The refusal is the engine's recorded result, read back through the detail route.
    const decidedView = data<Approval>(await view(requestId, world.tokens.root).expect(200));
    expect(decidedView.details?.outcome).toEqual(expect.objectContaining({
      requeueResults: [{ jobId: 'not-a-job', ok: false, error: 'not a re-queue candidate' }],
    }));
    expect((await prisma.budgetPolicy.findUniqueOrThrow({ where: { id: policy.id } })).pausedAt).toBeNull();
  });

  it('raising to an amount not above the window spend fails the request and leaves the policy paused', async () => {
    const { requestId, policy } = await budgetAsk();

    // The policy allows 10 and the window has already spent 10, so 5 leaves the pause pointless. The engine records
    // the approve, the command refuses inside its execution transaction, and the request settles `failed`.
    const decided = data<Approval>(await decide(requestId, padmin, {
      decision: 'approve', params: { amountUsd: 5 },
    }).expect(200));

    expect(decided).toEqual(expect.objectContaining({ id: requestId, status: 'failed' }));
    expect(decided.result).toEqual({ error: 'execution-failed', name: 'ValidationAppException' });
    const after = await prisma.budgetPolicy.findUniqueOrThrow({ where: { id: policy.id } });
    expect(after.pausedAt).not.toBeNull();
    expect(after.amountUsd).toEqual(new Prisma.Decimal(10));
  });

  it('raising on an ask whose policy is no longer paused fails the request and resumes nothing', async () => {
    const { requestId, policy } = await budgetAsk({ paused: false });

    const decided = data<Approval>(await decide(requestId, padmin, {
      decision: 'approve', params: { amountUsd: 20 },
    }).expect(200));

    expect(decided).toEqual(expect.objectContaining({ id: requestId, status: 'failed' }));
    expect(decided.result).toEqual({ error: 'execution-failed', name: 'ConflictAppException' });
    const after = await prisma.budgetPolicy.findUniqueOrThrow({ where: { id: policy.id } });
    expect(after).toEqual(expect.objectContaining({ pausedAt: null, amountUsd: new Prisma.Decimal(10) }));
  });

  it('keep_paused is a reject: the ask is rejected and the policy stays paused (US-010 AC-14)', async () => {
    const { requestId, policy } = await budgetAsk();

    const decided = data<Approval>(await decide(requestId, padmin, { decision: 'reject' }).expect(200));

    expect(decided).toEqual(expect.objectContaining({ id: requestId, status: 'rejected' }));
    expect(decided.decisions).toEqual([expect.objectContaining({ decision: 'reject' })]);
    expect(await requestOf(requestId)).toMatchObject({ status: 'rejected' });
    const after = await prisma.budgetPolicy.findUniqueOrThrow({ where: { id: policy.id } });
    expect(after.pausedAt).not.toBeNull();
    expect(after.amountUsd).toEqual(new Prisma.Decimal(10));
  });

  it('AC-1: approving a budget ask with an amount above spend lifts the pause and re-queues the candidate', async () => {
    const { requestId, policy, queued } = await budgetAsk();

    const decided = data<Approval>(await decide(requestId, padmin, {
      decision: 'approve', params: { amountUsd: 20, requeueJobIds: [queued.id] },
    }).expect(200));

    expect(decided).toEqual(expect.objectContaining({ id: requestId, status: 'executed' }));
    expect(decided.result).toEqual({ resumedAmountUsd: '20' });
    const decidedView = data<Approval>(await view(requestId, padmin).expect(200));
    expect(decidedView.details?.outcome).toEqual(expect.objectContaining({ requeueResults: [{ jobId: queued.id, ok: true }] }));
    const after = await prisma.budgetPolicy.findUniqueOrThrow({ where: { id: policy.id } });
    expect(after).toMatchObject({ pausedAt: null, pausedWindowStart: null });
    expect(after.amountUsd).toEqual(new Prisma.Decimal(20));
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: queued.id } })).state).toBe('QUEUED');
  });

  it('AC-3: approving a bash ask with params { choice: allow_for_job } writes one APPROVAL_ANSWER for the job', async () => {
    // `allow_for_job` is the fleet's name for nax's `allow-remember` option; the command's params contract
    // (and every decision row the migrator writes) names the fleet choice, so the engine must not leak
    // the option name into `params.choice`.
    const { requestId, job: running } = await bashAsk({ options: ['allow', 'allow-remember', 'deny'] });

    const decided = data<Approval>(
      await decide(requestId, world.tokens.dev, { decision: 'approve', params: { choice: 'allow_for_job' } }).expect(200),
    );

    expect(decided).toEqual(expect.objectContaining({ status: 'executed' }));
    // The persisted params are the command's own parsed decision: the fleet's choice name plus the nax
    // option it maps to, so `allow_for_job` survives a round trip.
    const decidedView = data<Approval>(await view(requestId, world.tokens.dev).expect(200));
    expect(decidedView.decisions).toEqual([expect.objectContaining({ decision: 'approve', params: { choice: 'allow_for_job', option: 'allow-remember' } })]);
    // The answer to the runner names nax's own option for that choice — the protocol's `ApprovalOption` has no
    // `allow_for_job` member — and there is exactly one of them.
    const commands = await prisma.fleetCommand.findMany({ where: { jobId: running.id, type: 'APPROVAL_ANSWER' } });
    expect(commands).toHaveLength(1);
    expect(commands[0].payload).toEqual(expect.objectContaining({ approvalId: requestId, choice: 'allow-remember' }));
  });
});

interface Approval {
  id: string;
  permissionKey: string;
  projectId: string | null;
  status: string;
  approverType: string | null;
  approverId: string | null;
  result: Record<string, unknown> | null;
  details: {
    kind?: string;
    jobId?: string;
    policyId?: string;
    resolvedBy: string | null;
    outcome: Record<string, unknown> | null;
    requeueCandidates?: Array<{ jobId: string }>;
    requeueCandidatesTruncated?: boolean;
  } | null;
  decisions: Array<{ decision: string; deciderType: string; deciderId: string; params: unknown }>;
}

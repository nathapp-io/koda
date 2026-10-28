import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Permissions P3 US-010 — the `/fleet/approvals/:id/decide` adapter, end to end (PG).
 *
 * The adapter's contract is "who may decide, before what they sent": a decided ask is 409, an
 * unauthorised caller is 403 whatever the body says, and only then do the fleet's offer rules answer
 * 400/409 before `ApprovalDecisionService` settles the request and runs its command. Every case posts a
 * structurally valid body through the real routes, so the DTO pipe is exercised but never the reason
 * for a refusal — the malformed combinations are semantic, not transport-level.
 *
 * The asks are seeded as the relay and the budget evaluator open them (`seedFleetAsk`; the evaluator for
 * the budget ones), so the row the adapter reads is the row production writes.
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

/** `FORBIDDEN` (`CommonExceptionCode.FORBIDDEN`): the code every `ForbiddenAppException` answers with. */
const FORBIDDEN = 40003;
/** `REQUEST_PARAMETER_ERROR`: the code every `ValidationAppException` answers with. */
const VALIDATION = -2;

describeIntegration('fleet approvals decide adapter (PG, US-010)', () => {
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
  const PROJECT = '/api/projects/web/fleet/approvals';
  const ADMIN = '/api/fleet/approvals';
  const decide = (url: string, id: string, token: string, body: Record<string, unknown>) =>
    request(server).post(`${url}/${id}/decide`).set(as(token)).send(body);
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

  it('AC-1: a decision on an already rejected ask is 409 fleet.approvalNotPending', async () => {
    const { requestId } = await bashAsk({
      status: 'rejected', decisions: [{ deciderType: 'USER', deciderId: padminId, decision: 'reject' }],
    });

    const res = await decide(PROJECT, requestId, padmin, { decision: 'allow' }).expect(409);

    expect(res.body).toEqual({ ret: 409, message: sentence('fleet.approvalNotPending.409') });
    // The state refusal came first: the pending check alone decides, so no second decision row exists.
    expect(await prisma.approvalDecision.count({ where: { requestId } })).toBe(1);
    expect(await requestOf(requestId)).toMatchObject({ status: 'rejected' });
  });

  it('AC-2: a viewer is 403 permissions before the body is validated', async () => {
    const { requestId } = await bashAsk();

    // `amountUsd` on a bash ask is a 400 for a caller who may decide; for a viewer the eligibility
    // check answers first, exactly as it does today.
    const res = await decide(PROJECT, requestId, world.tokens.viewer, { decision: 'allow', amountUsd: 5 }).expect(403);

    expect(res.body).toEqual({ ret: FORBIDDEN, message: sentence('permissions.40003') });
    expect(await requestOf(requestId)).toMatchObject({ status: 'pending', approverId: null });
    expect((await linkOf(requestId)).resolvedBy).toBeNull();
  });

  it('AC-3: an agent deciding the ask of the job it requested is 403 fleet.approvalSelfDecide', async () => {
    const { requestId } = await bashAsk({ requestedBy: { type: 'AGENT', id: agent.id } });

    // The engine's `tier-too-low` (an agent contributes only `self` to an `agent` default) rides on the
    // ask's own agent, so it keeps its own error code instead of the generic permission refusal.
    const res = await decide(PROJECT, requestId, agent.apiKey, { decision: 'allow' }).expect(403);

    expect(res.body).toEqual({ ret: FORBIDDEN, message: sentence('fleet.approvalSelfDecide.40003') });
    expect(await requestOf(requestId)).toMatchObject({ status: 'pending', approverId: null });
  });

  it('AC-4: a developer sending budget fields on a bash ask is 400 fleet.approvalInput', async () => {
    const { requestId } = await bashAsk();

    const res = await decide(PROJECT, requestId, world.tokens.dev, { decision: 'allow', amountUsd: 5 }).expect(400);

    expect(res.body).toEqual({
      ret: VALIDATION,
      message: sentence('fleet.approvalInput.-2', { reason: 'amountUsd and requeueJobIds apply only to budget approvals' }),
    });
    expect(await requestOf(requestId)).toMatchObject({ status: 'pending' });
  });

  it('AC-5: allowing an ask whose command was truncated is 400 fleet.approvalDecisionInvalid, and it stays pending', async () => {
    const { requestId, job: unanswered } = await bashAsk({ commandTruncated: true });

    const res = await decide(PROJECT, requestId, world.tokens.dev, { decision: 'allow' }).expect(400);

    expect(res.body).toEqual({
      ret: VALIDATION,
      message: sentence('fleet.approvalDecisionInvalid.-2', { reason: 'the command was truncated; it can only be denied' }),
    });
    expect(await requestOf(requestId)).toMatchObject({ status: 'pending', approverId: null });
    // A refused decide writes nothing at all: no decision row, no answer for the runner.
    expect(await prisma.approvalDecision.count({ where: { requestId } })).toBe(0);
    expect(await prisma.fleetCommand.count({ where: { jobId: unanswered.id } })).toBe(0);
  });

  it('AC-6: allowing a running job’s ask approves it and answers the runner once', async () => {
    const { requestId, job: running } = await bashAsk();

    const decided = data<Approval>(
      await decide(PROJECT, requestId, world.tokens.dev, { decision: 'allow' }).expect(200),
    );

    expect(decided).toEqual(expect.objectContaining({
      id: requestId, type: 'nax_bash_escalate', status: 'approved', decision: 'allow', resolvedBy: 'user', decidedById: world.ids.dev,
    }));
    expect(await requestOf(requestId)).toMatchObject({ status: 'executed', approverType: 'USER', approverId: world.ids.dev });
    const commands = await prisma.fleetCommand.findMany({ where: { jobId: running.id, type: 'APPROVAL_ANSWER' } });
    expect(commands).toHaveLength(1);
    // The answer names the request it resolves and the option nax offered (US-008).
    expect(commands[0].payload).toEqual(expect.objectContaining({ approvalId: requestId, choice: 'allow' }));
  });

  it('AC-7: denying a running job’s ask rejects it', async () => {
    const { requestId } = await bashAsk();

    const decided = data<Approval>(
      await decide(PROJECT, requestId, world.tokens.dev, { decision: 'deny' }).expect(200),
    );

    expect(decided).toEqual(expect.objectContaining({ id: requestId, status: 'rejected', decision: 'deny', resolvedBy: 'user' }));
    expect(await requestOf(requestId)).toMatchObject({ status: 'rejected' });
  });

  it('AC-8: allowing the ask of a completed job is 409 fleet.approvalNotPending', async () => {
    const { requestId, job: ended } = await bashAsk({ jobState: 'COMPLETED' });

    // The command finds the job ended and answers nothing, which today's decide reports as a conflict.
    const res = await decide(PROJECT, requestId, world.tokens.dev, { decision: 'allow' }).expect(409);

    expect(res.body).toEqual({ ret: 409, message: sentence('fleet.approvalNotPending.409') });
    expect((await linkOf(requestId)).resolvedBy).toBe('job_ended');
    expect(await prisma.fleetCommand.count({ where: { jobId: ended.id } })).toBe(0);
  });

  it('AC-9: denying the ask of a completed job is 409 fleet.approvalNotPending', async () => {
    const { requestId } = await bashAsk({ jobState: 'COMPLETED' });

    const res = await decide(PROJECT, requestId, world.tokens.dev, { decision: 'deny' }).expect(409);

    expect(res.body).toEqual({ ret: 409, message: sentence('fleet.approvalNotPending.409') });
    expect((await linkOf(requestId)).resolvedBy).toBe('job_ended');
  });

  it('AC-10: an admin raising without an amount is 400 fleet.approvalDecisionInvalid, and the ask stays pending', async () => {
    const { requestId } = await budgetAsk();

    const res = await decide(ADMIN, requestId, world.tokens.root, { decision: 'raise_budget_and_resume' }).expect(400);

    expect(res.body).toEqual({
      ret: VALIDATION, message: sentence('fleet.approvalDecisionInvalid.-2', { reason: 'amountUsd is required to raise and resume' }),
    });
    expect(await requestOf(requestId)).toMatchObject({ status: 'pending', approverId: null });
  });

  it('AC-11: raising with an id that is not a re-queue candidate is 400 fleet.approvalDecisionInvalid', async () => {
    const { requestId } = await budgetAsk();

    const res = await decide(ADMIN, requestId, world.tokens.root, {
      decision: 'raise_budget_and_resume', amountUsd: 20, requeueJobIds: ['not-a-job'],
    }).expect(400);

    expect(res.body).toEqual({
      ret: VALIDATION, message: sentence('fleet.approvalDecisionInvalid.-2', { reason: 'job not-a-job is not a re-queue candidate' }),
    });
    expect(await requestOf(requestId)).toMatchObject({ status: 'pending', approverId: null });
  });

  it('AC-12: raising to an amount not above the window spend is 400 fleet.budgetAmountNotAboveSpend', async () => {
    const { requestId } = await budgetAsk();

    // The policy allows 10 and the window has already spent 10, so 5 leaves the pause pointless.
    const res = await decide(PROJECT, requestId, padmin, { decision: 'raise_budget_and_resume', amountUsd: 5 }).expect(400);

    expect(res.body).toEqual({
      ret: VALIDATION, message: sentence('fleet.budgetAmountNotAboveSpend.-2', { amountUsd: '5', spentUsd: '10' }),
    });
    expect(await requestOf(requestId)).toMatchObject({ status: 'pending', approverId: null });
  });

  it('AC-13: raising on an ask whose policy is no longer paused is 409 fleet.budgetNotPaused', async () => {
    const { requestId } = await budgetAsk({ paused: false });

    const res = await decide(PROJECT, requestId, padmin, { decision: 'raise_budget_and_resume', amountUsd: 20 }).expect(409);

    expect(res.body).toEqual({ ret: 409, message: sentence('fleet.budgetNotPaused.409') });
    expect(await requestOf(requestId)).toMatchObject({ status: 'pending', approverId: null });
  });

  it('AC-14: keep_paused rejects the ask and leaves the policy paused', async () => {
    const { requestId, policy } = await budgetAsk();

    const decided = data<Approval>(
      await decide(PROJECT, requestId, padmin, { decision: 'keep_paused' }).expect(200),
    );

    expect(decided).toEqual(expect.objectContaining({ id: requestId, status: 'rejected', decision: 'keep_paused', resolvedBy: 'user' }));
    expect(await requestOf(requestId)).toMatchObject({ status: 'rejected' });
    const after = await prisma.budgetPolicy.findUniqueOrThrow({ where: { id: policy.id } });
    expect(after.pausedAt).not.toBeNull();
    expect(after.amountUsd).toEqual(new Prisma.Decimal(10));
  });

  it('AC-15: raise_budget_and_resume approves the ask and lifts the pause', async () => {
    const { requestId, policy } = await budgetAsk();

    const decided = data<Approval>(
      await decide(PROJECT, requestId, padmin, { decision: 'raise_budget_and_resume', amountUsd: 20 }).expect(200),
    );

    expect(decided).toEqual(expect.objectContaining({ id: requestId, status: 'approved', decision: 'raise_budget_and_resume' }));
    expect(decided.outcome).toEqual(expect.objectContaining({ resumedAmountUsd: '20' }));
    const after = await prisma.budgetPolicy.findUniqueOrThrow({ where: { id: policy.id } });
    expect(after).toMatchObject({ pausedAt: null, pausedWindowStart: null });
    expect(after.amountUsd).toEqual(new Prisma.Decimal(20));
  });

  it('allow_for_job reaches the bash command as the fleet choice, not as nax’s option name', async () => {
    // `allow_for_job` is the fleet's name for nax's `allow-remember` option; the command's params contract
    // (and every decision row the migrator writes) names the fleet choice, so the adapter must not leak
    // the option name into `params.choice`.
    const { requestId, job: running } = await bashAsk({ options: ['allow', 'allow-remember', 'deny'] });

    const decided = data<Approval>(
      await decide(PROJECT, requestId, world.tokens.dev, { decision: 'allow_for_job' }).expect(200),
    );

    expect(decided).toEqual(expect.objectContaining({ status: 'approved', decision: 'allow_for_job', resolvedBy: 'user' }));
    // The persisted params are the command's own parsed decision: the fleet's choice name plus the nax
    // option it maps to. The fleet view reads `choice`, so `allow_for_job` survives a round trip.
    const [decision] = await prisma.approvalDecision.findMany({ where: { requestId } });
    expect(decision.params).toEqual({ choice: 'allow_for_job', option: 'allow-remember' });
    // The answer to the runner, though, names nax's own option for that choice.
    const commands = await prisma.fleetCommand.findMany({ where: { jobId: running.id, type: 'APPROVAL_ANSWER' } });
    expect(commands).toHaveLength(1);
    expect(commands[0].payload).toEqual(expect.objectContaining({ approvalId: requestId, choice: 'allow-remember' }));
  });
});

interface Approval {
  id: string;
  type: string;
  status: string;
  decision: string | null;
  decidedById: string | null;
  resolvedBy: string | null;
  outcome: Record<string, unknown> | null;
}

import { ForbiddenAppException, NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import type { ApprovalRequestRecord } from '../../approvals/domain/approval.domain';
import {
  ApprovalDecisionParamsInvalidError, ApprovalDecideForbiddenError, ApprovalRequestExpiredError, ApprovalRequestNotPendingError,
} from '../../approvals/domain/approval.errors';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { ApprovalsService, type ApprovalCaller, type ApprovalRoute } from './approvals.service';
import { MAX_REQUEUE_CANDIDATES, type FleetApprovalRecord } from './domain/approval.domain';
import { FleetApprovalAskStore } from './fleet-approval-ask.store';

const NOW = new Date('2026-10-02T10:00:00.000Z');

const pendingBudget = (over: Partial<FleetApprovalRecord> = {}): FleetApprovalRecord => ({
  id: 'a1', type: 'budget_override_required', status: 'pending', projectId: 'p1', jobId: null, leaseEpoch: null, naxAskId: null,
  policyId: 'pol', payload: {}, outcome: null, requestedAt: NOW, expiresAt: null, decision: null, decidedById: null, decidedAt: null,
  resolvedBy: null, comment: null, createdAt: NOW, updatedAt: NOW, ...over,
});

const pendingBash = (over: Partial<FleetApprovalRecord> = {}): FleetApprovalRecord => pendingBudget({
  type: 'nax_bash_escalate', policyId: null, jobId: 'j1', leaseEpoch: 2, naxAskId: 'ask-1f2e3d4c',
  payload: { command: 'ls', commandTruncated: false, options: ['allow', 'deny'] }, ...over,
});

/** The engine request behind the ask: `decideEligibility` reads its actor, on-behalf-of and required mode. */
const engineRequest = (over: Partial<ApprovalRequestRecord> = {}): ApprovalRequestRecord => ({
  id: 'a1', permissionKey: 'fleet.budget.override', projectId: 'p1', actor: { type: 'SYSTEM', id: 'budget' }, onBehalfOf: null,
  origin: 'system', correlationId: 'c1', input: {}, inputHash: 'h1', requiredMode: 'agent', policyId: null, onTimeout: 'reject',
  approverMustHoldAction: true, requireDistinctApprover: false, status: 'pending', satisfiedBy: null, approverType: null,
  approverId: null, expiresAt: NOW, decidedAt: null, settledAt: null, result: null, createdAt: NOW, ...over,
});

const userPrincipal = (id: string, role: 'MEMBER' | 'ADMIN' = 'MEMBER'): KodaPrincipal =>
  ({ actorType: 'user', id, role, email: `${id}@koda.test`, name: id, blacklisted: false, revoked: false, authorities: [] });
const agentPrincipal = (id: string): KodaPrincipal =>
  ({
    actorType: 'agent', id, slug: id, status: 'ACTIVE', agentRoles: [], capabilities: [],
    name: id, blacklisted: false, revoked: false, authorities: [],
  });

/** What every key a decide needs: the action, and `approval.decide` narrowed to it. */
const DECIDE_KEYS = ['fleet.budget.override', 'fleet.job.shell.escalate', 'approval.decide@fleet.budget.override', 'approval.decide@fleet.job.shell.escalate'];

/**
 * The service over doubles of the three things it now talks to: the ask store (reads), the request queries (the engine
 * row `decideEligibility` reads) and `ApprovalDecisionService`. `after` is the view the second read answers — the
 * store's mapping of the request once the engine has settled it — so a case asserts the DTO the caller receives.
 */
function build(over: {
  before?: FleetApprovalRecord | null;
  after?: Partial<FleetApprovalRecord>;
  request?: ApprovalRequestRecord | null;
  keys?: readonly string[];
} = {}) {
  const before = over.before === undefined ? pendingBudget() : over.before;
  let reads = 0;
  const store = {
    findApproval: vi.fn(async () => {
      reads += 1;
      if (before === null) return null;
      return reads === 1 || over.after === undefined ? before : { ...before, ...over.after };
    }),
    findPage: vi.fn(async () => ({
      total: 1, current: 1, size: 10, hasNext: false, hasPrev: false, records: [before ?? pendingBudget()],
    })),
    countPending: vi.fn(async () => [{ projectId: 'p1', slug: 'web', pending: 2 }]),
    countPendingAllProjects: vi.fn(async () => [{ projectId: 'p1', slug: 'web', pending: 2 }]),
    countPendingUnscoped: vi.fn(async () => 3),
    findRequeueCandidates: vi.fn(async () => [
      { jobId: 'j1', projectId: 'p1', feature: 'f1', queuedAt: NOW },
      { jobId: 'j2', projectId: 'p2', feature: 'f2', queuedAt: NOW },
    ]),
  };
  const queries = { findById: vi.fn(async () => (over.request === undefined ? engineRequest() : over.request)) };
  const decisions = { decide: vi.fn(async () => engineRequest({ status: 'executed' })), recordDecision: vi.fn(async () => engineRequest({ status: 'approved' })) };
  const execution = { execute: vi.fn(async () => engineRequest({ status: 'executed' })) };
  const budgets = { assertResumable: vi.fn(async () => undefined), resume: vi.fn() };
  const permissions = { effectiveKeys: vi.fn(async () => new Set(over.keys ?? DECIDE_KEYS)) };
  const service = new ApprovalsService(
    store as unknown as FleetApprovalAskStore, queries as never, decisions as never, budgets as never, permissions as never, execution as never,
  );
  return { service, store, queries, decisions, budgets, permissions, execution };
}

/** `AppException` carries its HTTP status in the `httpStatus` getter; 0 = resolved. */
const statusOf = (p: Promise<unknown>): Promise<number> => p.then(() => 0, (e: { httpStatus?: number }) => e.httpStatus ?? -1);
const failureOf = (p: Promise<unknown>): Promise<Record<string, unknown>> => p.then(() => ({}), (e: Record<string, unknown>) => e);

const ADMIN_CALLER: ApprovalCaller & { principal: KodaPrincipal } = { id: 'root', principal: userPrincipal('root', 'ADMIN') };
const DEV_CALLER: ApprovalCaller & { principal: KodaPrincipal } = { id: 'dev', principal: userPrincipal('dev') };
const PROJECT: ApprovalRoute = { kind: 'project', projectId: 'p1' };
const ADMIN: ApprovalRoute = { kind: 'admin' };

describe('ApprovalsService reads over the ask store (fix round 1)', () => {
  it('lists the store page with the route’s project as the only extra filter', async () => {
    const { service, store } = build();

    const page = await service.list(PROJECT, { status: 'pending', type: 'budget_override_required', jobId: 'j1' }, { current: 1, size: 10 });

    expect(store.findPage).toHaveBeenCalledWith(
      { status: 'pending', type: 'budget_override_required', jobId: 'j1', projectId: 'p1' }, { current: 1, size: 10 },
    );
    expect(page.records.map((a) => a.id)).toEqual(['a1']);
    await service.list(ADMIN, {}, { current: 1, size: 10 });
    expect(store.findPage).toHaveBeenLastCalledWith({}, { current: 1, size: 10 });
  });

  it('answers 404 fleet.approvals for a row of another project or a missing one', async () => {
    expect(await failureOf(build({ before: pendingBudget({ projectId: 'p9' }) }).service.get(PROJECT, 'a1')))
      .toMatchObject({ prefix: 'fleet.approvals', httpStatus: 404 });
    expect(await failureOf(build({ before: null }).service.get(PROJECT, 'a1')))
      .toMatchObject({ prefix: 'fleet.approvals', httpStatus: 404 });
  });

  it('a pending budget ask includes its re-queue candidates, over-fetched by one to flag truncation', async () => {
    const { service, store } = build();
    store.findRequeueCandidates.mockResolvedValue(
      Array.from({ length: MAX_REQUEUE_CANDIDATES + 1 }, (_, i) => ({ jobId: `j${i}`, projectId: 'p1', feature: `f${i}`, queuedAt: NOW })),
    );

    const dto = await service.get(PROJECT, 'a1');

    expect(store.findRequeueCandidates).toHaveBeenCalledWith('pol', NOW, MAX_REQUEUE_CANDIDATES + 1);
    expect(dto.requeueCandidates).toHaveLength(MAX_REQUEUE_CANDIDATES);
    expect(dto.requeueCandidatesTruncated).toBe(true);
    expect((await service.get(PROJECT, 'a1')).requeueCandidates).toHaveLength(MAX_REQUEUE_CANDIDATES);
  });

  it('counts every project plus unscoped for { all: true }, and only the given projects otherwise (D235, US-006)', async () => {
    const all = build();
    expect(await all.service.counts({ all: true })).toEqual({ total: 5, unscoped: 3, projects: [{ projectId: 'p1', slug: 'web', pending: 2 }] });
    expect(all.store.countPendingAllProjects).toHaveBeenCalledTimes(1);
    expect(all.store.countPending).not.toHaveBeenCalled();

    const scoped = build();
    expect(await scoped.service.counts({ all: false, projectIds: ['p1'] })).toEqual({ total: 2, unscoped: 0, projects: [{ projectId: 'p1', slug: 'web', pending: 2 }] });
    expect(scoped.store.countPending).toHaveBeenCalledWith(['p1']);
    expect(scoped.store.countPendingAllProjects).not.toHaveBeenCalled();
    expect(scoped.store.countPendingUnscoped).not.toHaveBeenCalled();
  });
});

describe('ApprovalsService.decide over the engine (fix round 1)', () => {
  it('keep_paused is the engine reject with no params, and the answer is the reloaded view', async () => {
    const { service, decisions, budgets } = build({ after: { status: 'rejected', decision: 'keep_paused', decidedById: 'root', comment: 'later', resolvedBy: 'user' } });

    const dto = await service.decide(ADMIN_CALLER, PROJECT, 'a1', { decision: 'keep_paused', comment: 'later' }, NOW);

    expect(decisions.decide).toHaveBeenCalledWith('a1', 'reject', 'later', NOW, undefined);
    expect(budgets.resume).not.toHaveBeenCalled();
    expect(dto).toEqual(expect.objectContaining({ status: 'rejected', decision: 'keep_paused', resolvedBy: 'user', decidedById: 'root', comment: 'later' }));
    // The fleet's outputs of the decision are the outbox recorder's (`FleetAskEventsSubscriber`), not this adapter's:
    // the adapter only translates the decision and answers the reloaded view.
  });

  it('raise_budget_and_resume becomes the engine approve with the amount and the de-duplicated candidate ids', async () => {
    const after = { status: 'approved', decision: 'raise_budget_and_resume' as const, decidedById: 'root', outcome: { resumedAmountUsd: '20.5', requeueResults: [] } };
    const { service, decisions, budgets, store } = build({ after });

    const dto = await service.decide(ADMIN_CALLER, PROJECT, 'a1', { decision: 'raise_budget_and_resume', amountUsd: 20.5, requeueJobIds: ['j1', 'j1', 'j2'] }, NOW);

    expect(store.findRequeueCandidates).toHaveBeenCalledWith('pol', NOW, MAX_REQUEUE_CANDIDATES);
    expect(budgets.assertResumable).toHaveBeenCalledWith('pol', 20.5, NOW);
    expect(decisions.decide).toHaveBeenCalledWith('a1', 'approve', null, NOW, { amountUsd: 20.5, requeueJobIds: ['j1', 'j2'] });
    expect(dto).toEqual(expect.objectContaining({ status: 'approved', decision: 'raise_budget_and_resume', outcome: { resumedAmountUsd: '20.5', requeueResults: [] } }));
  });

  it('a raise the policy cannot take keeps the adapter’s own 409 or 400 and never reaches the engine', async () => {
    const paused = build();
    paused.budgets.assertResumable.mockRejectedValueOnce(new ConflictAppException({}, 'fleet.budgetNotPaused'));
    expect(await statusOf(paused.service.decide(ADMIN_CALLER, PROJECT, 'a1', { decision: 'raise_budget_and_resume', amountUsd: 20 }, NOW))).toBe(409);
    expect(paused.decisions.decide).not.toHaveBeenCalled();

    const spend = build();
    spend.budgets.assertResumable.mockRejectedValueOnce(new ValidationAppException({}, 'fleet.budgetAmountNotAboveSpend'));
    expect(await failureOf(spend.service.decide(ADMIN_CALLER, PROJECT, 'a1', { decision: 'raise_budget_and_resume', amountUsd: 5 }, NOW)))
      .toMatchObject({ prefix: 'fleet.budgetAmountNotAboveSpend', httpStatus: 400 });
    expect(spend.decisions.decide).not.toHaveBeenCalled();
  });

  it.each([
    [{ decision: 'raise_budget_and_resume' as const }, 'amountUsd is required to raise and resume'],
    [{ decision: 'raise_budget_and_resume' as const, amountUsd: 20, requeueJobIds: ['zzz'] }, 'job zzz is not a re-queue candidate'],
    [{ decision: 'allow' as const }, 'allow does not apply to a budget approval'],
    [{ decision: 'approve' as const }, 'approve does not apply to a budget approval'],
  ])('refuses %p with 400 fleet.approvalDecisionInvalid', async (dto, reason) => {
    const { service, decisions } = build();

    expect(await failureOf(service.decide(ADMIN_CALLER, PROJECT, 'a1', dto, NOW)))
      .toMatchObject({ prefix: 'fleet.approvalDecisionInvalid', httpStatus: 400, args: { reason } });
    expect(decisions.decide).not.toHaveBeenCalled();
  });

  it('refuses a raise on a budget ask with no policy (plan D236)', async () => {
    const { service, decisions } = build({ before: pendingBudget({ policyId: null }) });
    expect(await statusOf(service.decide(ADMIN_CALLER, PROJECT, 'a1', { decision: 'raise_budget_and_resume', amountUsd: 20 }, NOW))).toBe(400);
    expect(decisions.decide).not.toHaveBeenCalled();
  });

  it.each([
    ['allow', 'approve', { choice: 'allow' }],
    // The engine's params carry the fleet's choice name; `allow-remember` is only how nax names the
    // option the runner is answered with (`checked.choice`), never what `parseDecision` accepts.
    ['allow_for_job', 'approve', { choice: 'allow_for_job' }],
    ['deny', 'reject', undefined],
  ] as const)('a bash %s is the engine %s', async (decision, engine, params) => {
    const { service, decisions } = build({
      // `allow_for_job` is only offered when nax offered `allow-remember` for the ask.
      before: pendingBash({ payload: { command: 'ls', commandTruncated: false, options: ['allow', 'allow-remember', 'deny'] } }),
      after: { type: 'nax_bash_escalate', status: decision === 'deny' ? 'rejected' : 'approved', decision, resolvedBy: 'user' },
    });

    const dto = await service.decide(DEV_CALLER, PROJECT, 'a1', { decision }, NOW);

    expect(decisions.decide).toHaveBeenCalledWith('a1', engine, null, NOW, params);
    expect(dto.status).toBe(decision === 'deny' ? 'rejected' : 'approved');
  });

  it('a bash choice nax did not offer, or a truncated command, is 400 before the engine is asked', async () => {
    const notOffered = build({ before: pendingBash({ payload: { command: 'ls', commandTruncated: false, options: ['deny'] } }) });
    expect(await failureOf(notOffered.service.decide(DEV_CALLER, PROJECT, 'a1', { decision: 'allow' }, NOW)))
      .toMatchObject({ prefix: 'fleet.approvalDecisionInvalid' });
    expect(notOffered.decisions.decide).not.toHaveBeenCalled();

    const truncated = build({ before: pendingBash({ payload: { command: 'ls', commandTruncated: true, options: ['allow', 'deny'] } }) });
    expect(await failureOf(truncated.service.decide(DEV_CALLER, PROJECT, 'a1', { decision: 'allow' }, NOW)))
      .toMatchObject({ prefix: 'fleet.approvalDecisionInvalid' });
  });

  it('budget fields on a bash decide are 400 fleet.approvalInput (D287)', async () => {
    const { service, decisions } = build({ before: pendingBash() });

    expect(await failureOf(service.decide(DEV_CALLER, PROJECT, 'a1', { decision: 'deny', amountUsd: 5 }, NOW)))
      .toMatchObject({ prefix: 'fleet.approvalInput', httpStatus: 400 });
    expect(decisions.decide).not.toHaveBeenCalled();
  });

  it('AC-24: an approval outside the route is 404 fleet.approvals before any key is evaluated', async () => {
    const { service, permissions, queries } = build({ before: pendingBudget({ projectId: 'p9' }) });

    const error = await service.decide(ADMIN_CALLER, PROJECT, 'a1', { decision: 'keep_paused' }, NOW).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundAppException);
    expect(error).toMatchObject({ prefix: 'fleet.approvals', httpStatus: 404 });
    expect(permissions.effectiveKeys).not.toHaveBeenCalled();
    expect(queries.findById).not.toHaveBeenCalled();
  });

  it('a decided ask is 409 fleet.approvalNotPending whatever the body says', async () => {
    const { service, permissions, decisions } = build({ before: pendingBudget({ status: 'approved' }) });

    expect(await failureOf(service.decide(ADMIN_CALLER, PROJECT, 'a1', { decision: 'allow' }, NOW)))
      .toMatchObject({ prefix: 'fleet.approvalNotPending', httpStatus: 409 });
    expect(permissions.effectiveKeys).not.toHaveBeenCalled();
    expect(decisions.decide).not.toHaveBeenCalled();
  });

  it('AC-25: a caller without the action and decide keys is 403 permissions before any write', async () => {
    const { service, decisions } = build({ keys: ['project.read'] });

    const error = await service.decide(DEV_CALLER, PROJECT, 'a1', { decision: 'keep_paused' }, NOW).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenAppException);
    expect(error).toMatchObject({ prefix: 'permissions', httpStatus: 403 });
    expect(decisions.decide).not.toHaveBeenCalled();
  });

  it('the ask’s own agent contributing only `self` is 403 fleet.approvalSelfDecide', async () => {
    const { service, decisions } = build({
      before: pendingBash(), request: engineRequest({ permissionKey: 'fleet.job.shell.escalate', onBehalfOf: { type: 'AGENT', id: 'a1' } }),
    });
    const agentCaller: ApprovalCaller & { principal: KodaPrincipal } = { id: 'a1', principal: agentPrincipal('a1') };

    const error = await service.decide(agentCaller, PROJECT, 'a1', { decision: 'allow' }, NOW).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenAppException);
    expect(error).toMatchObject({ prefix: 'fleet.approvalSelfDecide', httpStatus: 403 });
    expect(decisions.decide).not.toHaveBeenCalled();
  });

  it('reads the decide keys in the ask’s own scope, and globally for an ask with no project', async () => {
    const scoped = build();
    await scoped.service.decide(ADMIN_CALLER, PROJECT, 'a1', { decision: 'keep_paused' }, NOW);
    expect(scoped.permissions.effectiveKeys).toHaveBeenCalledWith({ type: 'USER', id: 'root' }, { projectId: 'p1' });

    const global = build({ before: pendingBudget({ projectId: null }), request: engineRequest({ projectId: null }) });
    await global.service.decide(ADMIN_CALLER, ADMIN, 'a1', { decision: 'keep_paused' }, NOW);
    expect(global.permissions.effectiveKeys).toHaveBeenCalledWith({ type: 'USER', id: 'root' }, 'global');
  });

  it.each([
    [new ApprovalRequestNotPendingError('approved'), 409, 'fleet.approvalNotPending'],
    [new ApprovalRequestExpiredError('a1'), 409, 'fleet.approvalNotPending'],
    [new ApprovalDecisionParamsInvalidError('invalid'), 400, 'fleet.approvalDecisionInvalid'],
    [new ApprovalDecideForbiddenError('tier-too-low'), 403, 'permissions'],
  ])('maps the engine’s %s onto the fleet error', async (error, status, prefix) => {
    const { service, decisions } = build();
    decisions.decide.mockRejectedValueOnce(error);

    const failure = await failureOf(service.decide(ADMIN_CALLER, PROJECT, 'a1', { decision: 'keep_paused' }, NOW));

    expect(failure).toMatchObject({ httpStatus: status, prefix });
  });

  it('an engine decision for a bash ask that found the job ended is 409 fleet.approvalNotPending (step 7)', async () => {
    const { service } = build({
      before: pendingBash(), after: { type: 'nax_bash_escalate', status: 'cancelled', resolvedBy: 'job_ended' },
    });

    expect(await failureOf(service.decide(DEV_CALLER, PROJECT, 'a1', { decision: 'allow' }, NOW)))
      .toMatchObject({ prefix: 'fleet.approvalNotPending', httpStatus: 409 });
  });
});

describe('fleet decide steps for the project route', () => {
  it('AC-8: checks and translates bash deny without recording or executing', async () => {
    const { service, decisions, execution } = build({ before: pendingBash(), request: engineRequest({ permissionKey: 'fleet.job.shell.escalate' }) });
    expect(await service.checkDecide(DEV_CALLER, PROJECT, 'a1', { decision: 'deny' }, NOW)).toEqual({
      key: 'fleet.approval.decide.bash', input: { requestId: 'a1', decision: 'reject', comment: null },
    });
    expect(decisions.recordDecision).not.toHaveBeenCalled();
    expect(execution.execute).not.toHaveBeenCalled();
  });
  it('AC-9: checks budget keep_paused under the budget type key', async () => {
    expect(await build().service.checkDecide(DEV_CALLER, PROJECT, 'a1', { decision: 'keep_paused' }, NOW)).toEqual({
      key: 'fleet.approval.decide.budget', input: { requestId: 'a1', decision: 'reject', comment: null },
    });
  });
  it.each([new ApprovalRequestNotPendingError('rejected'), new ApprovalRequestExpiredError('a1')])('AC-10: maps recordDecision %s to the fleet 409', async (error) => {
    const { service, decisions } = build();
    decisions.recordDecision.mockRejectedValueOnce(error);
    await expect(service.recordDecide(DEV_CALLER.principal, { requestId: 'a1', decision: 'reject', comment: null }))
      .rejects.toMatchObject({ httpStatus: 409, prefix: 'fleet.approvalNotPending' });
  });
  it('records without executing, then explicitly executes and reloads the view', async () => {
    const { service, decisions, execution } = build({ before: pendingBash() });
    await service.recordDecide(DEV_CALLER.principal, { requestId: 'a1', decision: 'approve', comment: 'ok', params: { choice: 'allow' } });
    expect(decisions.recordDecision).toHaveBeenCalledWith('a1', 'approve', 'ok', expect.any(Date), { choice: 'allow' });
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(execution.execute).not.toHaveBeenCalled();
    await service.executeDecided(DEV_CALLER.principal, 'a1');
    expect(execution.execute).toHaveBeenCalledWith('a1');
    expect(await service.view('a1')).toMatchObject({ id: 'a1' });
  });
  it('view preserves job_ended conflict and executeDecided maps engine errors', async () => {
    const { service, execution } = build({ before: pendingBash({ resolvedBy: 'job_ended' }) });
    await expect(service.view('a1')).rejects.toMatchObject({ httpStatus: 409, prefix: 'fleet.approvalNotPending' });
    execution.execute.mockRejectedValueOnce(new ApprovalRequestExpiredError('a1'));
    await expect(service.executeDecided(DEV_CALLER.principal, 'a1')).rejects.toMatchObject({ httpStatus: 409, prefix: 'fleet.approvalNotPending' });
  });
  it('checks pending and eligibility before body translation', async () => {
    await expect(build({ before: pendingBash({ status: 'rejected' }) }).service.checkDecide(DEV_CALLER, PROJECT, 'a1', { decision: 'deny' }, NOW))
      .rejects.toMatchObject({ httpStatus: 409, prefix: 'fleet.approvalNotPending' });
    await expect(build({ before: pendingBash(), keys: ['project.read'] }).service.checkDecide(DEV_CALLER, PROJECT, 'a1', { decision: 'deny', amountUsd: 5 }, NOW))
      .rejects.toMatchObject({ httpStatus: 403, prefix: 'permissions' });
  });
});

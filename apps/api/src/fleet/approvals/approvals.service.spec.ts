import { ApprovalsService } from './approvals.service';
import type { FleetApprovalRecord } from './domain/approval.domain';

const NOW = new Date('2026-10-02T10:00:00.000Z');
const pendingBudget = (over: Partial<FleetApprovalRecord> = {}): FleetApprovalRecord => ({
  id: 'a1', type: 'budget_override_required', status: 'pending', projectId: 'p1', jobId: null, leaseEpoch: null, naxAskId: null,
  policyId: 'pol', payload: {}, outcome: null, requestedAt: NOW, expiresAt: null, decision: null, decidedById: null, decidedAt: null,
  resolvedBy: null, comment: null, createdAt: NOW, updatedAt: NOW, ...over,
});

function build(approval: FleetApprovalRecord | null, policyScope: 'project' | 'global' = 'project') {
  let row = approval;
  const repo = {
    findById: jest.fn(async () => row),
    lockById: jest.fn(async () => row),
    resolve: jest.fn(async (_id: string, x: Partial<FleetApprovalRecord>) => (row = { ...(row as FleetApprovalRecord), ...x })),
    setOutcome: jest.fn(async (_id: string, outcome: Record<string, unknown>) => (row = { ...(row as FleetApprovalRecord), outcome })),
    findRequeueCandidates: jest.fn(async () => [
      { jobId: 'j1', projectId: 'p1', feature: 'f1', queuedAt: NOW },
      { jobId: 'j2', projectId: 'p2', feature: 'f2', queuedAt: NOW },
    ]),
    countPending: jest.fn(async () => [{ projectId: 'p1', slug: 'web', pending: 2 }]),
    countPendingUnscoped: jest.fn(async () => 3),
  };
  const policy = policyScope === 'project'
    ? { id: 'pol', scopeType: 'project', projectId: 'p1' }
    : { id: 'pol', scopeType: 'global', projectId: null };
  const budgetRepo = { lockById: jest.fn(async () => policy) };
  const budgets = { resume: jest.fn(async () => ({})) };
  const jobs = { requeue: jest.fn(async (_a: string, _p: string, id: string) => { if (id === 'j2') throw new Error('fleet.jobs'); return {}; }) };
  const closer = { recordResolved: jest.fn(async () => []) };
  const live = { publish: jest.fn() };
  const activity = { memberProjectIds: jest.fn(async () => ['p1']) };
  const tx = { run: jest.fn(async (fn: () => Promise<unknown>) => fn()) };
  const service = new ApprovalsService(repo as never, budgetRepo as never, budgets as never, jobs as never, closer as never, live as never, activity as never, tx as never);
  return { service, repo, budgets, jobs, budgetRepo };
}

/** AppException carries its HTTP status in the `httpStatus` getter; 0 = resolved. */
const statusOf = (p: Promise<unknown>): Promise<number> => p.then(() => 0, (e: { httpStatus?: number }) => e.httpStatus ?? -1);
const ADMIN_CALLER = { id: 'root', globalAdmin: true };
const PROJECT_ADMIN = { kind: 'project' as const, projectId: 'p1', role: 'ADMIN' };
const PROJECT_DEV = { kind: 'project' as const, projectId: 'p1', role: 'DEVELOPER' };

describe('ApprovalsService.decide (budget)', () => {
  it('keep_paused rejects the approval without resuming', async () => {
    const { service, budgets } = build(pendingBudget());
    const dto = await service.decide(ADMIN_CALLER, PROJECT_ADMIN, 'a1', { decision: 'keep_paused', comment: 'later' }, NOW);
    expect(dto).toEqual(expect.objectContaining({ status: 'rejected', decision: 'keep_paused', resolvedBy: 'user', decidedById: 'root', comment: 'later' }));
    expect(budgets.resume).not.toHaveBeenCalled();
  });

  it('raise_budget_and_resume resumes on the policy route (D229), then re-queues and keeps failures (A9, D233)', async () => {
    const { service, budgets, jobs } = build(pendingBudget({ projectId: null }), 'global');
    const dto = await service.decide(ADMIN_CALLER, { kind: 'admin' }, 'a1', { decision: 'raise_budget_and_resume', amountUsd: 20, requeueJobIds: ['j1', 'j2'] }, NOW);
    expect(budgets.resume).toHaveBeenCalledWith('root', { kind: 'admin' }, 'pol', 20, NOW, { approvalId: 'a1' });
    expect(jobs.requeue.mock.calls).toEqual([['root', 'p1', 'j1'], ['root', 'p2', 'j2']]);
    expect(dto.status).toBe('approved');
    expect(dto.outcome).toEqual({ resumedAmountUsd: '20', requeueResults: [{ jobId: 'j1', ok: true }, { jobId: 'j2', ok: false, error: 'fleet.jobs' }] });
  });

  it('a project policy decided on the admin prefix resumes on the project route (review focus 5)', async () => {
    const { service, budgets } = build(pendingBudget());
    await service.decide(ADMIN_CALLER, { kind: 'admin' }, 'a1', { decision: 'raise_budget_and_resume', amountUsd: 20 }, NOW);
    expect(budgets.resume).toHaveBeenCalledWith('root', { kind: 'project', projectId: 'p1' }, 'pol', 20, NOW, { approvalId: 'a1' });
  });

  it('refuses: amount missing, foreign re-queue id, project developer, not pending, other project, bash type', async () => {
    expect(await statusOf(build(pendingBudget()).service.decide(ADMIN_CALLER, PROJECT_ADMIN, 'a1', { decision: 'raise_budget_and_resume' }, NOW))).toBe(400);
    expect(await statusOf(build(pendingBudget()).service.decide(ADMIN_CALLER, PROJECT_ADMIN, 'a1', { decision: 'raise_budget_and_resume', amountUsd: 20, requeueJobIds: ['zzz'] }, NOW))).toBe(400);
    expect(await statusOf(build(pendingBudget()).service.decide({ id: 'dev', globalAdmin: false }, PROJECT_DEV, 'a1', { decision: 'keep_paused' }, NOW))).toBe(403);
    expect(await statusOf(build(pendingBudget({ status: 'approved' })).service.decide(ADMIN_CALLER, PROJECT_ADMIN, 'a1', { decision: 'keep_paused' }, NOW))).toBe(409);
    expect(await statusOf(build(pendingBudget({ projectId: 'p9' })).service.decide(ADMIN_CALLER, PROJECT_ADMIN, 'a1', { decision: 'keep_paused' }, NOW))).toBe(404);
    expect(await statusOf(build(pendingBudget({ type: 'nax_bash_escalate' })).service.decide(ADMIN_CALLER, PROJECT_ADMIN, 'a1', { decision: 'deny' }, NOW))).toBe(400);
    expect(await statusOf(build(pendingBudget()).service.decide(ADMIN_CALLER, PROJECT_ADMIN, 'a1', { decision: 'allow' }, NOW))).toBe(400);
  });

  it('locks the policy before the approval (lock order, spec §1.4)', async () => {
    const { service, repo, budgetRepo } = build(pendingBudget());
    await service.decide(ADMIN_CALLER, PROJECT_ADMIN, 'a1', { decision: 'keep_paused' }, NOW);
    expect(budgetRepo.lockById.mock.invocationCallOrder[0]).toBeLessThan(repo.lockById.mock.invocationCallOrder[0]);
  });
});

describe('ApprovalsService.counts', () => {
  it('sums member projects, plus unscoped for a global admin only (D235)', async () => {
    expect(await build(null).service.counts({ id: 'root', globalAdmin: true })).toEqual({ total: 5, unscoped: 3, projects: [{ projectId: 'p1', slug: 'web', pending: 2 }] });
    expect(await build(null).service.counts({ id: 'dev', globalAdmin: false })).toEqual({ total: 2, unscoped: 0, projects: [{ projectId: 'p1', slug: 'web', pending: 2 }] });
  });
});

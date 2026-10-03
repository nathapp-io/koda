import { ForbiddenAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { ApprovalCloser } from './approval-closer';
import { ApprovalsService } from './approvals.service';
import { MAX_REQUEUE_CANDIDATES, type FleetApprovalRecord } from './domain/approval.domain';

const NOW = new Date('2026-10-02T10:00:00.000Z');
const pendingBudget = (over: Partial<FleetApprovalRecord> = {}): FleetApprovalRecord => ({
  id: 'a1', type: 'budget_override_required', status: 'pending', projectId: 'p1', jobId: null, leaseEpoch: null, naxAskId: null,
  policyId: 'pol', payload: {}, outcome: null, requestedAt: NOW, expiresAt: null, decision: null, decidedById: null, decidedAt: null,
  resolvedBy: null, comment: null, createdAt: NOW, updatedAt: NOW, ...over,
});

function build(approval: FleetApprovalRecord | null, policyScope: 'project' | 'project-orphan' | 'global' = 'project') {
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
    : policyScope === 'project-orphan'
      ? { id: 'pol', scopeType: 'project', projectId: null } // not producible via the API (resolveScope always sets it)
      : { id: 'pol', scopeType: 'global', projectId: null };
  const budgetRepo = { lockById: jest.fn(async () => policy) };
  // The DB shape, not the request shape: `amountUsd` is `numeric(12,4)`, so a round-trip of 20.5 reads
  // back as `'20.5000'` and `String(20.5)` is `'20.5'`. A fake echoing the request number would let a
  // re-added `?? String(dto.amountUsd)` fallback pass, which is why the store value is scaled here and
  // the assertions below pin the scaled form.
  const budgets = { resume: jest.fn(async () => ({ amountUsd: '20.5000' })) };
  const jobs = {
    requeue: jest.fn(async (_a: string, _p: string, id: string) => {
      if (id === 'j2') throw new ConflictAppException({ activeJobId: 'j9' }, 'fleet.jobs');
      return {};
    }),
  };
  const closer = { recordResolved: jest.fn(async () => []) };
  const live = { publish: jest.fn() };
  const activity = { memberProjectIds: jest.fn(async () => ['p1']) };
  const tx = { run: jest.fn(async (fn: () => Promise<unknown>) => fn()) };
  const jobRepo = { lockById: jest.fn(), createCommand: jest.fn() };
  const notifier = { notify: jest.fn() };
  const service = new ApprovalsService(repo as never, budgetRepo as never, budgets as never, jobs as never, closer as never, live as never, activity as never, tx as never, jobRepo as never, notifier as never);
  return { service, repo, budgets, jobs, budgetRepo, jobRepo, notifier };
}

/**
 * Bash decide goes through a real ApprovalCloser over an in-memory approval repo (the fake from
 * approval-closer.spec.ts, plus `findById` for `findVisible`), so `expire`/`recordResolved` really
 * resolve rows and write activity.
 */
function buildBash() {
  const rows = new Map<string, FleetApprovalRecord>();
  const repo = {
    findById: jest.fn(async (id: string) => rows.get(id) ?? null),
    lockById: jest.fn(async (id: string) => rows.get(id) ?? null),
    resolve: jest.fn(async (id: string, x: Partial<FleetApprovalRecord>) => {
      const row = { ...(rows.get(id) as FleetApprovalRecord), ...x };
      rows.set(id, row);
      return row;
    }),
    create: jest.fn(),
    findPendingForPolicy: jest.fn(async () => null),
    findByAsk: jest.fn(async () => null),
    findPendingForJob: jest.fn(async () => []),
    findProjectSlug: jest.fn(async () => 'web'),
  };
  const activity = { record: jest.fn(async () => undefined), memberProjectIds: jest.fn(async () => ['p1']) };
  const webhooks = { dispatch: jest.fn(async () => undefined) };
  const closerLive = { event: jest.fn((a: FleetApprovalRecord) => (a.projectId ? [{ approvalId: a.id, status: a.status }] : [])) };
  const closer = new ApprovalCloser(repo as never, activity as never, webhooks as never, closerLive as never);
  const live = { publish: jest.fn() };
  const budgetRepo = { lockById: jest.fn() };
  const budgets = { resume: jest.fn() };
  const jobs = { requeue: jest.fn() };
  const tx = { run: jest.fn(async (fn: () => Promise<unknown>) => fn()) };
  const jobRepo = { lockById: jest.fn(), createCommand: jest.fn() };
  const notifier = { notify: jest.fn() };
  const service = new ApprovalsService(repo as never, budgetRepo as never, budgets as never, jobs as never, closer as never, live as never, activity as never, tx as never, jobRepo as never, notifier as never);
  // Defaults the brief's row literals leave out but the service/DTO touch (e.g. requestedAt).
  const seed = (a: Record<string, unknown> & { id: string }) => {
    rows.set(a.id, {
      requestedAt: NOW, outcome: null, policyId: null, decision: null, decidedById: null, decidedAt: null,
      resolvedBy: null, comment: null, createdAt: NOW, updatedAt: NOW, ...a,
    } as FleetApprovalRecord);
  };
  return { service, rows, seed, jobRepo, notifier };
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
    const dto = await service.decide(ADMIN_CALLER, { kind: 'admin' }, 'a1', { decision: 'raise_budget_and_resume', amountUsd: 20.5, requeueJobIds: ['j1', 'j2'] }, NOW);
    expect(budgets.resume).toHaveBeenCalledWith('root', { kind: 'admin' }, 'pol', 20.5, NOW, { approvalId: 'a1' });
    expect(jobs.requeue.mock.calls).toEqual([['root', 'p1', 'j1'], ['root', 'p2', 'j2']]);
    expect(dto.status).toBe('approved');
    // Money crosses as the DB decimal string, never the request number (D233 / review F6). `'20.5000'`
    // is what `numeric(12,4)` gives back for 20.5 and `'20.5'` is what `String(20.5)` gives, so this
    // assertion fails if the value is ever rebuilt from the request instead of read from the store.
    expect(dto.outcome).toEqual({
      resumedAmountUsd: '20.5000',
      requeueResults: [
        { jobId: 'j1', ok: true },
        // The failure keeps its i18n coordinates, so `activeJobId` survives into the persisted outcome.
        { jobId: 'j2', ok: false, error: JSON.stringify({ code: 'fleet.jobs', args: { activeJobId: 'j9' } }) },
      ],
    });
  });

  it('a re-queue failure that is not an AppException stores no internal text (review F1)', async () => {
    const { service, jobs } = build(pendingBudget());
    jobs.requeue.mockRejectedValue(new Error('Connection to the database failed'));
    const dto = await service.decide(ADMIN_CALLER, PROJECT_ADMIN, 'a1', { decision: 'raise_budget_and_resume', amountUsd: 20.5, requeueJobIds: ['j1'] }, NOW);
    expect(dto.outcome).toEqual({ resumedAmountUsd: '20.5000', requeueResults: [{ jobId: 'j1', ok: false, error: 'unexpected error' }] });
    expect(JSON.stringify(dto.outcome)).not.toContain('Connection to the database');
  });

  it('a repeated re-queue id is re-queued once (a subset is a set, spec §1.5)', async () => {
    const { service, jobs } = build(pendingBudget());
    const dto = await service.decide(ADMIN_CALLER, PROJECT_ADMIN, 'a1', { decision: 'raise_budget_and_resume', amountUsd: 20.5, requeueJobIds: ['j1', 'j1'] }, NOW);
    expect(jobs.requeue).toHaveBeenCalledTimes(1);
    expect(dto.outcome).toEqual({ resumedAmountUsd: '20.5000', requeueResults: [{ jobId: 'j1', ok: true }] });
  });

  it('a project policy with no projectId never resumes on a project route (review F7)', async () => {
    // Not producible via the API, but a null `projectId` on a project-scope policy must not become
    // `{kind:'project', projectId: null}` under a cast: `owns()` matches on the id, so a project route
    // would compare `null === route.projectId` and fail confusingly. It degrades to the admin route,
    // where `ADMIN_SCOPES` excludes a project scope, so the real BudgetsService answers 404.
    const { service, budgets } = build(pendingBudget(), 'project-orphan');
    await service.decide(ADMIN_CALLER, { kind: 'admin' }, 'a1', { decision: 'raise_budget_and_resume', amountUsd: 20.5 }, NOW);
    expect(budgets.resume).toHaveBeenCalledWith('root', { kind: 'admin' }, 'pol', 20.5, NOW, { approvalId: 'a1' });
  });

  it('a project policy decided on the admin prefix resumes on the project route (review focus 5)', async () => {
    const { service, budgets } = build(pendingBudget());
    await service.decide(ADMIN_CALLER, { kind: 'admin' }, 'a1', { decision: 'raise_budget_and_resume', amountUsd: 20.5 }, NOW);
    expect(budgets.resume).toHaveBeenCalledWith('root', { kind: 'project', projectId: 'p1' }, 'pol', 20.5, NOW, { approvalId: 'a1' });
  });

  it('refuses: amount missing, foreign re-queue id, project developer, not pending, other project, bash with no job', async () => {
    expect(await statusOf(build(pendingBudget()).service.decide(ADMIN_CALLER, PROJECT_ADMIN, 'a1', { decision: 'raise_budget_and_resume' }, NOW))).toBe(400);
    expect(await statusOf(build(pendingBudget()).service.decide(ADMIN_CALLER, PROJECT_ADMIN, 'a1', { decision: 'raise_budget_and_resume', amountUsd: 20, requeueJobIds: ['zzz'] }, NOW))).toBe(400);
    expect(await statusOf(build(pendingBudget()).service.decide({ id: 'dev', globalAdmin: false }, PROJECT_DEV, 'a1', { decision: 'keep_paused' }, NOW))).toBe(403);
    expect(await statusOf(build(pendingBudget({ status: 'approved' })).service.decide(ADMIN_CALLER, PROJECT_ADMIN, 'a1', { decision: 'keep_paused' }, NOW))).toBe(409);
    expect(await statusOf(build(pendingBudget({ projectId: 'p9' })).service.decide(ADMIN_CALLER, PROJECT_ADMIN, 'a1', { decision: 'keep_paused' }, NOW))).toBe(404);
    expect(await statusOf(build(pendingBudget({ type: 'nax_bash_escalate' })).service.decide(ADMIN_CALLER, PROJECT_ADMIN, 'a1', { decision: 'deny' }, NOW))).toBe(400);
    expect(await statusOf(build(pendingBudget({ policyId: null })).service.decide(ADMIN_CALLER, PROJECT_ADMIN, 'a1', { decision: 'keep_paused' }, NOW))).toBe(400);
    expect(await statusOf(build(pendingBudget()).service.decide(ADMIN_CALLER, PROJECT_ADMIN, 'a1', { decision: 'allow' }, NOW))).toBe(400);
  });

  it('locks the policy before the approval (lock order, spec §1.4)', async () => {
    const { service, repo, budgetRepo } = build(pendingBudget());
    await service.decide(ADMIN_CALLER, PROJECT_ADMIN, 'a1', { decision: 'keep_paused' }, NOW);
    expect(budgetRepo.lockById.mock.invocationCallOrder[0]).toBeLessThan(repo.lockById.mock.invocationCallOrder[0]);
  });

  it('refuses an unauthorized caller before validating the decision, and takes no lock (spec §2.3)', async () => {
    const { service, repo, budgetRepo, budgets } = build(pendingBudget());
    // `allow` does not apply to a budget approval, but role is answered first: the status must not
    // depend on the request body.
    expect(await statusOf(service.decide({ id: 'dev', globalAdmin: false }, PROJECT_DEV, 'a1', { decision: 'allow' }, NOW))).toBe(403);
    expect(await statusOf(service.decide({ id: 'dev', globalAdmin: false }, PROJECT_DEV, 'a1', { decision: 'raise_budget_and_resume', amountUsd: 20 }, NOW))).toBe(403);
    expect(budgetRepo.lockById).not.toHaveBeenCalled();
    expect(repo.lockById).not.toHaveBeenCalled();
    expect(budgets.resume).not.toHaveBeenCalled();
  });
});

describe('ApprovalsService.counts', () => {
  it('sums member projects, plus unscoped for a global admin only (D235)', async () => {
    expect(await build(null).service.counts({ id: 'root', globalAdmin: true })).toEqual({ total: 5, unscoped: 3, projects: [{ projectId: 'p1', slug: 'web', pending: 2 }] });
    expect(await build(null).service.counts({ id: 'dev', globalAdmin: false })).toEqual({ total: 2, unscoped: 0, projects: [{ projectId: 'p1', slug: 'web', pending: 2 }] });
  });
});

describe('bash decide (S1.5 §2.3, plan D265-D267)', () => {
  const pending = { id: 'a1', type: 'nax_bash_escalate', status: 'pending', projectId: 'p1', jobId: 'j1', leaseEpoch: 2,
    naxAskId: 'ask-1f2e3d4c', expiresAt: new Date(NOW.getTime() + 60_000), payload: { command: 'ls', commandTruncated: false, options: ['allow', 'deny'] } };
  const running = { id: 'j1', state: 'RUNNING', leaseEpoch: 2, runnerId: 'r1', requestedById: 'u9' };
  const dev = { kind: 'project', projectId: 'p1', role: 'DEVELOPER' } as const;
  const DEV_CALLER = { id: 'dev', globalAdmin: false };

  it('a DEVELOPER allows: approved, APPROVAL_ANSWER for the job runner and epoch, notify after commit', async () => {
    const { service, seed, jobRepo, notifier } = buildBash();
    seed(pending); jobRepo.lockById.mockResolvedValue(running);
    const dto = await service.decide(DEV_CALLER, dev, 'a1', { decision: 'allow' }, NOW);
    expect(dto).toEqual(expect.objectContaining({ status: 'approved', decision: 'allow', resolvedBy: 'user' }));
    expect(jobRepo.createCommand).toHaveBeenCalledWith({ runnerId: 'r1', jobId: 'j1', type: 'APPROVAL_ANSWER', leaseEpoch: 2,
      payload: { approvalId: 'a1', naxAskId: 'ask-1f2e3d4c', choice: 'allow' } });
    expect(notifier.notify).toHaveBeenCalledWith('r1');
  });

  it('deny is rejected and sends choice deny', async () => {
    const { service, seed, jobRepo } = buildBash();
    seed(pending); jobRepo.lockById.mockResolvedValue(running);
    await expect(service.decide(DEV_CALLER, dev, 'a1', { decision: 'deny' }, NOW)).resolves.toEqual(expect.objectContaining({ status: 'rejected' }));
    expect(jobRepo.createCommand).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ choice: 'deny' }) }));
  });

  it.each(['VIEWER', 'MEMBER', 'AGENT', null])('role %p is forbidden (D266)', async (role) => {
    const { service, seed } = buildBash();
    seed(pending);
    await expect(service.decide(DEV_CALLER, { ...dev, role }, 'a1', { decision: 'deny' }, NOW)).rejects.toThrow(ForbiddenAppException);
  });

  it('expired at decide commits the expiry, then answers 409 (D265)', async () => {
    const { service, rows, seed, jobRepo } = buildBash();
    seed({ ...pending, expiresAt: new Date(NOW.getTime() - 1) }); jobRepo.lockById.mockResolvedValue(running);
    await expect(service.decide(DEV_CALLER, dev, 'a1', { decision: 'allow' }, NOW)).rejects.toThrow(ConflictAppException);
    expect(rows.get('a1')).toEqual(expect.objectContaining({ status: 'expired', resolvedBy: 'timeout' }));
    expect(jobRepo.createCommand).not.toHaveBeenCalled();
  });

  it('a job that left RUNNING closes the ask job_ended, then 409', async () => {
    const { service, rows, seed, jobRepo } = buildBash();
    seed(pending); jobRepo.lockById.mockResolvedValue({ ...running, state: 'UPLOADING' });
    await expect(service.decide(DEV_CALLER, dev, 'a1', { decision: 'allow' }, NOW)).rejects.toThrow(ConflictAppException);
    expect(rows.get('a1')).toEqual(expect.objectContaining({ status: 'cancelled', resolvedBy: 'job_ended' }));
  });

  it('a second decide gets 409', async () => {
    const { service, seed, jobRepo } = buildBash();
    seed({ ...pending, status: 'approved' }); jobRepo.lockById.mockResolvedValue(running);
    await expect(service.decide(DEV_CALLER, dev, 'a1', { decision: 'deny' }, NOW)).rejects.toThrow(ConflictAppException);
  });

  it('budget-only fields on a bash decide are 400 (D287)', async () => {
    const { service, seed } = buildBash();
    seed(pending);
    await expect(service.decide(DEV_CALLER, dev, 'a1', { decision: 'deny', amountUsd: 5 }, NOW)).rejects.toThrow(ValidationAppException);
  });

  it('allow on a truncated command is 400 before any lock', async () => {
    const { service, seed, jobRepo } = buildBash();
    seed({ ...pending, payload: { ...pending.payload, commandTruncated: true } });
    await expect(service.decide(DEV_CALLER, dev, 'a1', { decision: 'allow' }, NOW)).rejects.toThrow(ValidationAppException);
    expect(jobRepo.lockById).not.toHaveBeenCalled();
  });
});

describe('ApprovalsService.get re-queue candidates', () => {
  it('over-fetches by one, returns the capped page and flags the truncation', async () => {
    const { service, repo } = build(pendingBudget());
    repo.findRequeueCandidates.mockResolvedValue(
      Array.from({ length: MAX_REQUEUE_CANDIDATES + 1 }, (_, i) => ({ jobId: `j${i}`, projectId: 'p1', feature: `f${i}`, queuedAt: NOW })),
    );
    const dto = await service.get(PROJECT_ADMIN, 'a1');
    expect(repo.findRequeueCandidates).toHaveBeenCalledWith('pol', NOW, MAX_REQUEUE_CANDIDATES + 1);
    expect(dto.requeueCandidates).toHaveLength(MAX_REQUEUE_CANDIDATES);
    expect(dto.requeueCandidates?.at(-1)).toEqual(expect.objectContaining({ jobId: `j${MAX_REQUEUE_CANDIDATES - 1}` }));
    expect(dto.requeueCandidatesTruncated).toBe(true);
  });

  it('an exact page is not flagged as truncated', async () => {
    const { service } = build(pendingBudget());
    expect(await service.get(PROJECT_ADMIN, 'a1')).toEqual(expect.objectContaining({ requeueCandidatesTruncated: false }));
  });
});

import { ApprovalCloser } from './approval-closer';
import type { FleetApprovalRecord, NewFleetApproval } from './domain/approval.domain';
import type { BudgetPolicyRecord } from '../budgets/domain/budget.domain';

const NOW = new Date('2026-10-02T10:00:00.000Z');
const policy = (over: Partial<BudgetPolicyRecord> = {}): BudgetPolicyRecord => ({
  id: 'pol', scopeType: 'project', scopeId: 'p1', scopeKey: 'project:p1', projectId: 'p1', windowKind: 'calendar_month_utc',
  amountUsd: '10', warnPercent: 80, hardStop: true, runningJobs: 'finish', pausedAt: NOW, pausedWindowStart: NOW,
  createdById: 'u0', updatedById: 'u1', createdAt: NOW, updatedAt: NOW, ...over,
});

function fakes() {
  const rows = new Map<string, FleetApprovalRecord>();
  let seq = 0;
  const repo = {
    create: jest.fn(async (d: NewFleetApproval) => {
      const row = { id: `a${++seq}`, status: 'pending', jobId: null, leaseEpoch: null, naxAskId: null, outcome: null, expiresAt: null,
        decision: null, decidedById: null, decidedAt: null, resolvedBy: null, comment: null, createdAt: NOW, updatedAt: NOW, ...d } as FleetApprovalRecord;
      rows.set(row.id, row);
      return row;
    }),
    findPendingForPolicy: jest.fn(async (id: string) => [...rows.values()].find((r) => r.policyId === id && r.status === 'pending') ?? null),
    findByAsk: jest.fn(async (jobId: string, leaseEpoch: number, naxAskId: string) =>
      [...rows.values()].find((r) => r.jobId === jobId && r.leaseEpoch === leaseEpoch && r.naxAskId === naxAskId) ?? null),
    findPendingForJob: jest.fn(async (jobId: string) =>
      [...rows.values()].filter((r) => r.jobId === jobId && r.status === 'pending')),
    lockById: jest.fn(async (id: string) => rows.get(id) ?? null),
    resolve: jest.fn(async (id: string, x: Partial<FleetApprovalRecord>) => {
      const row = { ...(rows.get(id) as FleetApprovalRecord), ...x };
      rows.set(id, row);
      return row;
    }),
    findProjectSlug: jest.fn(async () => 'web'),
  };
  const activity = { record: jest.fn(async () => undefined) };
  const webhooks = { dispatch: jest.fn(async () => undefined) };
  const live = { event: jest.fn((a: FleetApprovalRecord) => (a.projectId ? [{ approvalId: a.id, status: a.status }] : [])) };
  const outbox = { record: jest.fn(async (e: { type: string }) => ({ id: 'ob1', ...e })) };
  const liveBus = { listenerCount: jest.fn(() => 0) };
  const closer = new ApprovalCloser(repo as never, activity as never, webhooks as never, live as never, outbox as never, liveBus as never);
  return { closer, repo, activity, webhooks, liveBus, outbox, rows };
}

describe('ApprovalCloser', () => {
  it('opens a budget approval with the stop snapshot, activity, webhook and live event', async () => {
    const { closer, activity, webhooks } = fakes();
    const r = await closer.openBudget(policy(), { windowStart: NOW, spentUsd: '10.5' }, NOW);
    expect(r.approval).toEqual(expect.objectContaining({
      type: 'budget_override_required', status: 'pending', projectId: 'p1', policyId: 'pol', requestedAt: NOW,
      payload: { scopeType: 'project', scopeId: 'p1', windowKind: 'calendar_month_utc', windowStart: NOW.toISOString(), spentUsd: '10.5', amountUsd: '10' },
    }));
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({
      actorType: 'SYSTEM', action: 'approval.requested', entityType: 'approval', entityId: r.approval?.id, projectId: 'p1', responsibleUserId: 'u1',
    }));
    expect(webhooks.dispatch).toHaveBeenCalledWith('p1', 'fleet.approval.requested', expect.objectContaining({ approvalId: r.approval?.id, path: `/web/fleet/approvals?id=${r.approval?.id}` }));
    expect(r.live).toHaveLength(1);
  });

  it('supersedes a stray pending approval before opening a new one', async () => {
    const { closer, rows } = fakes();
    const first = await closer.openBudget(policy(), { windowStart: NOW, spentUsd: '10' }, NOW);
    const second = await closer.openBudget(policy(), { windowStart: NOW, spentUsd: '11' }, NOW);
    expect(rows.get(first.approval?.id as string)).toEqual(expect.objectContaining({ status: 'cancelled', resolvedBy: 'superseded' }));
    expect(second.approval?.status).toBe('pending');
    // The stray's live frame is carried forward alongside the new one; the caller publishes both after commit.
    expect(second.live).toEqual([
      { approvalId: first.approval?.id, status: 'cancelled' },
      { approvalId: second.approval?.id, status: 'pending' },
    ]);
  });

  it('sends no webhook and no live event for a policy with no project', async () => {
    const { closer, webhooks } = fakes();
    const r = await closer.openBudget(policy({ scopeType: 'global', scopeId: null, projectId: null }), { windowStart: NOW, spentUsd: '1' }, NOW);
    expect(webhooks.dispatch).not.toHaveBeenCalled();
    expect(r.live).toEqual([]);
  });

  it('closes the pending approval of a policy, or does nothing when there is none', async () => {
    const { closer, activity, webhooks } = fakes();
    expect(await closer.closeForPolicy('pol', { status: 'cancelled', resolvedBy: 'window_reset', actor: { type: 'SYSTEM', id: 'system', responsibleUserId: 'u1' } }, NOW))
      .toEqual({ approval: null, live: [] });
    await closer.openBudget(policy(), { windowStart: NOW, spentUsd: '10' }, NOW);
    const r = await closer.closeForPolicy('pol', {
      status: 'approved', resolvedBy: 'manual_resume', decision: 'raise_budget_and_resume',
      actor: { type: 'USER', id: 'u9', responsibleUserId: 'u9' }, outcome: { resumedAmountUsd: '20', requeueResults: [] },
    }, NOW);
    expect(r.approval).toEqual(expect.objectContaining({ status: 'approved', resolvedBy: 'manual_resume', decidedById: 'u9', decidedAt: NOW, outcome: { resumedAmountUsd: '20', requeueResults: [] } }));
    expect(activity.record).toHaveBeenLastCalledWith(expect.objectContaining({ actorType: 'USER', actorId: 'u9', action: 'approval.decided' }));
    expect(webhooks.dispatch).toHaveBeenLastCalledWith('p1', 'fleet.approval.resolved', expect.objectContaining({ status: 'approved' }));
  });

  it('records a cancelled close as approval.cancelled with no decider', async () => {
    const { closer, activity } = fakes();
    await closer.openBudget(policy(), { windowStart: NOW, spentUsd: '10' }, NOW);
    const r = await closer.closeForPolicy('pol', { status: 'cancelled', resolvedBy: 'policy_deleted', actor: { type: 'USER', id: 'u9', responsibleUserId: 'u9' } }, NOW);
    expect(r.approval).toEqual(expect.objectContaining({ status: 'cancelled', decidedById: null, decision: null }));
    expect(activity.record).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'approval.cancelled' }));
  });
});

describe('bash (S1.5 2a)', () => {
  let closer!: ReturnType<typeof fakes>['closer'];
  let repo!: ReturnType<typeof fakes>['repo'];
  let activity!: ReturnType<typeof fakes>['activity'];
  let webhooks!: ReturnType<typeof fakes>['webhooks'];
  let liveBus!: ReturnType<typeof fakes>['liveBus'];
  let outbox!: ReturnType<typeof fakes>['outbox'];
  let rows!: ReturnType<typeof fakes>['rows'];
  beforeEach(() => { ({ closer, repo, activity, webhooks, liveBus, outbox, rows } = fakes()); });
  const job = { id: 'j1', projectId: 'p1', leaseEpoch: 2, state: 'RUNNING', bashMode: 'escalate', approvalTimeoutSec: 600, requestedById: 'u9' } as const;
  const ask = (over: Partial<{ naxAskId: string; deadlineAt: Date }> = {}) => ({
    naxAskId: 'ask-1f2e3d4c', deadlineAt: new Date(NOW.getTime() + 300_000), payload: { command: 'bun run test' }, ...over,
  });

  it('opens a pending ask expiring at the earlier of nax deadline and job timeout, with requested activity and webhook', async () => {
    const { approval, live } = await closer.openBash(job, ask(), 'r1', NOW);
    expect(approval).toEqual(expect.objectContaining({
      type: 'nax_bash_escalate', status: 'pending', projectId: 'p1', jobId: 'j1', leaseEpoch: 2, naxAskId: 'ask-1f2e3d4c',
      policyId: null, expiresAt: new Date(NOW.getTime() + 300_000),
    }));
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'RUNNER', actorId: 'r1', responsibleUserId: 'u9', action: 'approval.requested' }));
    expect(webhooks.dispatch).toHaveBeenCalledWith('p1', 'fleet.approval.requested', expect.anything());
    expect(live).toHaveLength(1);
  });

  it('enqueues a fleet_approval_requested outbox event when no decider is watching live (#208)', async () => {
    liveBus.listenerCount.mockReturnValue(0);
    const { approval } = await closer.openBash(job, ask(), 'r1', NOW);
    expect(outbox.record).toHaveBeenCalledWith(expect.objectContaining({
      type: 'fleet_approval_requested',
      payload: expect.objectContaining({ approvalId: approval?.id, projectId: 'p1', jobId: 'j1', path: `/web/fleet/approvals?id=${approval?.id}` }),
      metadata: { projectId: 'p1', eventId: approval?.id },
    }));
  });

  it('skips the outbox enqueue when a decider is already watching live (#208)', async () => {
    liveBus.listenerCount.mockReturnValue(1);
    await closer.openBash(job, ask(), 'r1', NOW);
    expect(outbox.record).not.toHaveBeenCalled();
  });

  it('does not enqueue an outbox event for a born-closed ask (#208)', async () => {
    liveBus.listenerCount.mockReturnValue(0);
    await closer.openBash({ ...job, state: 'UPLOADING' }, ask(), 'r1', NOW);
    expect(outbox.record).not.toHaveBeenCalled();
  });

  it('caps expiresAt at requestedAt + approvalTimeoutSec', async () => {
    const { approval } = await closer.openBash({ ...job, approvalTimeoutSec: 60 }, ask(), 'r1', NOW);
    expect(approval?.expiresAt).toEqual(new Date(NOW.getTime() + 60_000));
  });

  it('is idempotent on (jobId, leaseEpoch, naxAskId)', async () => {
    const first = await closer.openBash(job, ask(), 'r1', NOW);
    const again = await closer.openBash(job, ask(), 'r1', NOW);
    expect(again.approval?.id).toBe(first.approval?.id);
    expect(again.live).toEqual([]);
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ state: 'UPLOADING' }, 'cancelled', 'job_ended'],
    [{ bashMode: 'raw' }, 'cancelled', 'job_ended'],
  ] as const)('a job %p gives a born-closed ask %s/%s without a webhook (D261)', async (over, status, resolvedBy) => {
    const { approval } = await closer.openBash({ ...job, ...over }, ask(), 'r1', NOW);
    expect(approval).toEqual(expect.objectContaining({ status, resolvedBy }));
    expect(webhooks.dispatch).not.toHaveBeenCalled();
    expect(activity.record).toHaveBeenCalledTimes(1);
  });

  it('a deadline already past gives expired/timeout', async () => {
    const { approval } = await closer.openBash(job, ask({ deadlineAt: new Date(NOW.getTime() - 1) }), 'r1', NOW);
    expect(approval).toEqual(expect.objectContaining({ status: 'expired', resolvedBy: 'timeout' }));
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'approval.expired' }));
  });

  it('closeForJob cancels every pending ask of the job with job_ended and a resolved webhook', async () => {
    await closer.openBash(job, ask(), 'r1', NOW);
    await closer.openBash(job, ask({ naxAskId: 'ask-00000002' }), 'r1', NOW);
    webhooks.dispatch.mockClear();
    const live = await closer.closeForJob(job, NOW);
    expect(live).toHaveLength(2);
    expect([...rows.values()].every((r) => r.status === 'cancelled' && r.resolvedBy === 'job_ended')).toBe(true);
    expect(webhooks.dispatch).toHaveBeenCalledWith('p1', 'fleet.approval.resolved', expect.anything());
  });

  it('expire marks expired/timeout with approval.expired activity (D262)', async () => {
    const { approval } = await closer.openBash(job, ask(), 'r1', NOW);
    expect(approval).toBeDefined();
    const { approval: expired } = await closer.expire(approval as FleetApprovalRecord, job, NOW);
    expect(expired).toEqual(expect.objectContaining({ status: 'expired', resolvedBy: 'timeout', decidedAt: NOW }));
    expect(activity.record).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'approval.expired', actorType: 'SYSTEM', responsibleUserId: 'u9' }));
  });
});

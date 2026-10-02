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
  const closer = new ApprovalCloser(repo as never, activity as never, webhooks as never, live as never);
  return { closer, repo, activity, webhooks, rows };
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

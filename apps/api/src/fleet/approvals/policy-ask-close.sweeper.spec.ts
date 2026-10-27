import { Logger } from '@nestjs/common';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { mockAuditRecorder } from '../../common/test-helpers/global-stubs.module';
import type { BudgetPolicyRecord } from '../budgets/domain/budget.domain';
import { ApprovalCloser } from './approval-closer';
import type { PolicyAskClose } from './domain/fleet-approval-ask.domain';
import { FleetApprovalAskStore } from './fleet-approval-ask.store';
import { MAX_POLICY_ASKS_PER_TICK, PolicyAskCloseSweeper } from './policy-ask-close.sweeper';

const NOW = new Date('2026-10-02T10:00:00.000Z');
const policy = (over: Partial<BudgetPolicyRecord> = {}): BudgetPolicyRecord => ({
  id: 'pol', scopeType: 'project', scopeId: 'p1', scopeKey: 'project:p1', projectId: 'p1', windowKind: 'calendar_month_utc',
  amountUsd: '10', warnPercent: 80, hardStop: true, runningJobs: 'finish', pausedAt: NOW, pausedWindowStart: NOW,
  createdById: 'u0', updatedById: 'u1', createdAt: NOW, updatedAt: NOW, ...over,
});
const claim = (over: Partial<PolicyAskClose> = {}): PolicyAskClose =>
  ({ requestId: 'a1', budgetPolicyId: 'pol', projectId: 'p1', pendingResolvedBy: 'policy_deleted', ...over });

/**
 * Permissions P3 US-007 fix round 2: the durable continuation of a bounded policy close. The sweeper only has to claim
 * the asks a close left behind and settle each in its own transaction with the resolution that close intended.
 */
function build(over: { claims?: PolicyAskClose[]; policy?: BudgetPolicyRecord | null } = {}) {
  const store = { claimPendingPolicyAsks: vi.fn(async () => over.claims ?? [claim()]) };
  const budgets = { findById: vi.fn(async () => (over.policy === undefined ? policy() : over.policy)) };
  const live = [{ approvalId: 'a1', status: 'cancelled' }];
  const closer = { closePolicyAsk: vi.fn(async (requestId: string) => ({ approval: { id: requestId }, live })) };
  const txManager = { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) };
  const livePublisher = { publish: vi.fn() };
  mockAuditRecorder.record.mockReset();
  mockAuditRecorder.record.mockImplementation(async () => undefined);
  const sweeper = new PolicyAskCloseSweeper(
    store as unknown as FleetApprovalAskStore, budgets as never, closer as unknown as ApprovalCloser,
    livePublisher as never, txManager as never, { sweepEnabled: false, approvalSweepMs: 60_000 },
    mockAuditRecorder as unknown as AuditRecorder,
  );
  return { sweeper, store, budgets, closer, livePublisher, txManager };
}

describe('PolicyAskCloseSweeper (US-007 fix round 2)', () => {
  it('settles each claimed ask with the resolution its close intended, and publishes after the close commits', async () => {
    const { sweeper, closer, livePublisher } = build();

    expect(await sweeper.tick(NOW)).toEqual({ closed: 1, failed: 0 });

    expect(closer.closePolicyAsk).toHaveBeenCalledWith('a1', {
      status: 'cancelled', resolvedBy: 'policy_deleted',
      actor: { type: 'SYSTEM', id: 'system', responsibleUserId: 'u1' },
    }, NOW);
    expect(mockAuditRecorder.record).toHaveBeenCalledWith(expect.objectContaining({
      key: 'system.approval.expire', resourceType: 'fleet-approval', resourceId: 'a1', projectId: 'p1',
      summary: 'policy close continued: policy_deleted',
    }));
    expect(livePublisher.publish).toHaveBeenCalledWith([{ approvalId: 'a1', status: 'cancelled' }]);
  });

  it('closes a leftover of a manual resume as approved for the fleet, not as a cancellation', async () => {
    const { sweeper, closer } = build({ claims: [claim({ pendingResolvedBy: 'manual_resume' })] });

    await sweeper.tick(NOW);

    expect(closer.closePolicyAsk).toHaveBeenCalledWith('a1', expect.objectContaining({ status: 'approved', resolvedBy: 'manual_resume' }), NOW);
  });

  it('a policy deleted before the continuation runs still closes, attributed to the system with no editor', async () => {
    const { sweeper, closer } = build({ policy: null });

    expect(await sweeper.tick(NOW)).toEqual({ closed: 1, failed: 0 });

    expect(closer.closePolicyAsk).toHaveBeenCalledWith('a1', {
      status: 'cancelled', resolvedBy: 'policy_deleted',
      actor: { type: 'SYSTEM', id: 'system', responsibleUserId: null },
    }, NOW);
  });

  it('a close the engine skipped (request still held) writes nothing and is retried on a later tick', async () => {
    const { sweeper, closer, livePublisher } = build();
    closer.closePolicyAsk.mockResolvedValueOnce({ approval: null, live: [] });

    expect(await sweeper.tick(NOW)).toEqual({ closed: 0, failed: 0 });
    expect(mockAuditRecorder.record).not.toHaveBeenCalled();
    expect(livePublisher.publish).not.toHaveBeenCalled();
  });

  it('one failing close is logged and skipped; the rest of the batch still runs', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
    const { sweeper, closer } = build({ claims: [claim(), claim({ requestId: 'a2' })] });
    closer.closePolicyAsk.mockRejectedValueOnce(new Error('connection lost'));

    expect(await sweeper.tick(NOW)).toEqual({ closed: 1, failed: 1 });
    expect(closer.closePolicyAsk).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.some(([message]) => String(message).includes('policy ask close failed'))).toBe(true);
  });

  it('logs the backlog it leaves when a tick fills the queue budget', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
    const claims = Array.from({ length: MAX_POLICY_ASKS_PER_TICK }, (_, i) => claim({ requestId: `a${i}` }));
    const { sweeper } = build({ claims });

    await sweeper.tick(NOW);

    expect(warn.mock.calls.some(([message]) => String(message).includes('next tick continues the queue'))).toBe(true);
  });
});

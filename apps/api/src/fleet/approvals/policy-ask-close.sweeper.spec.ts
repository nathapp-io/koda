import { Logger } from '@nestjs/common';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { mockAuditRecorder } from '../../common/test-helpers/global-stubs.module';
import { ApprovalCloser } from './approval-closer';
import type { PersistedPolicyClose, PolicyAskClose } from './domain/fleet-approval-ask.domain';
import { FleetApprovalAskStore } from './fleet-approval-ask.store';
import { MAX_POLICY_ASKS_PER_TICK, PolicyAskCloseSweeper } from './policy-ask-close.sweeper';

const NOW = new Date('2026-10-02T10:00:00.000Z');
const deleted: PersistedPolicyClose = {
  resolvedBy: 'policy_deleted', status: 'cancelled', actor: { type: 'USER', id: 'u9', responsibleUserId: 'u9' },
};
const claim = (over: Partial<PolicyAskClose> = {}): PolicyAskClose =>
  ({ requestId: 'a1', budgetPolicyId: 'pol', projectId: 'p1', pendingClose: deleted, ...over });

/**
 * Permissions P3 US-007 fix round 2: the durable continuation of a bounded policy close. The sweeper only has to claim
 * the asks a close left behind and settle each in its own transaction with the resolution that close intended.
 */
function build(over: { claims?: PolicyAskClose[] } = {}) {
  const store = { claimPendingPolicyAsks: vi.fn(async () => over.claims ?? [claim()]) };
  const closer = { closePolicyAsk: vi.fn(async (requestId: string) => ({ approval: { id: requestId } })) };
  const txManager = { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) };
  mockAuditRecorder.record.mockReset();
  mockAuditRecorder.record.mockImplementation(async () => undefined);
  const sweeper = new PolicyAskCloseSweeper(
    store as unknown as FleetApprovalAskStore, closer as unknown as ApprovalCloser,
    txManager as never, { sweepEnabled: false, approvalSweepMs: 60_000 },
    mockAuditRecorder as unknown as AuditRecorder,
  );
  return { sweeper, store, closer, txManager };
}

describe('PolicyAskCloseSweeper (US-007 fix round 2)', () => {
  it('replays the close its action persisted in its close transaction', async () => {
    const { sweeper, closer } = build();

    expect(await sweeper.tick(NOW)).toEqual({ closed: 1, failed: 0 });

    expect(closer.closePolicyAsk).toHaveBeenCalledWith('a1', deleted, NOW);
    expect(mockAuditRecorder.record).toHaveBeenCalledWith(expect.objectContaining({
      key: 'system.approval.expire', resourceType: 'fleet-approval', resourceId: 'a1', projectId: 'p1',
      summary: 'policy close continued: policy_deleted',
    }));
  });

  it('fix round 3: a deferred manual resume keeps its outcome, its resumer and its actor', async () => {
    const resume: PersistedPolicyClose = {
      resolvedBy: 'manual_resume', status: 'approved', actor: { type: 'USER', id: 'u9', responsibleUserId: 'u9' },
      outcome: { resumedAmountUsd: '20', requeueResults: [] },
    };
    const { sweeper, closer } = build({ claims: [claim({ pendingClose: resume })] });

    await sweeper.tick(NOW);

    expect(closer.closePolicyAsk).toHaveBeenCalledWith('a1', resume, NOW);
  });

  it('a close the engine skipped (request still held) writes nothing and is retried on a later tick', async () => {
    const { sweeper, closer } = build();
    closer.closePolicyAsk.mockResolvedValueOnce({ approval: null });

    expect(await sweeper.tick(NOW)).toEqual({ closed: 0, failed: 0 });
    expect(mockAuditRecorder.record).not.toHaveBeenCalled();
  });

  it('attributes the continued close to the actor the action recorded, not to the policy row', async () => {
    const { sweeper, closer } = build();

    await sweeper.tick(NOW);

    // The actor travels with the intent: a delete by an admin is still that admin's, after the policy row is gone.
    expect(closer.closePolicyAsk).toHaveBeenCalledWith('a1', expect.objectContaining({
      actor: { type: 'USER', id: 'u9', responsibleUserId: 'u9' },
    }), NOW);
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

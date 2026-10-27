import { APPROVAL_REQUEST_CHANGED, type ApprovalRequestChangedPayload } from '../../approvals/approval-request-events';
import type { ApprovalRequestRecord } from '../../approvals/domain/approval.domain';
import type { BudgetPolicyRecord } from '../budgets/domain/budget.domain';
import { FleetAskEventsSubscriber } from './fleet-ask-events.subscriber';
import type { FleetApprovalRecord } from './domain/approval.domain';
import type { FleetApprovalAskRecord } from './domain/fleet-approval-ask.domain';

const NOW = new Date('2026-10-02T10:00:00.000Z');

const link = (over: Partial<FleetApprovalAskRecord> = {}): FleetApprovalAskRecord => ({
  requestId: 'a1', kind: 'budget', projectId: 'p1', jobId: null, leaseEpoch: null, naxAskId: null, budgetPolicyId: 'pol',
  resolvedBy: null, outcome: null, pendingResolvedBy: null, recordedStatus: null, createdAt: NOW, updatedAt: NOW, ...over,
});
const view = (over: Partial<FleetApprovalRecord> = {}): FleetApprovalRecord => ({
  id: 'a1', type: 'budget_override_required', status: 'approved', projectId: 'p1', jobId: null, leaseEpoch: null, naxAskId: null,
  policyId: 'pol', payload: {}, outcome: null, requestedAt: NOW, expiresAt: null, decision: 'raise_budget_and_resume',
  decidedById: 'u9', decidedAt: NOW, resolvedBy: 'user', comment: null, createdAt: NOW, updatedAt: NOW, ...over,
});
const request = (over: Partial<ApprovalRequestRecord> = {}): ApprovalRequestRecord => ({
  id: 'a1', permissionKey: 'fleet.budget.override', projectId: 'p1', actor: { type: 'SYSTEM', id: 'budget' }, onBehalfOf: null,
  origin: 'system', correlationId: 'c1', input: {}, inputHash: 'h1', requiredMode: 'agent', policyId: null, onTimeout: 'reject',
  approverMustHoldAction: true, requireDistinctApprover: false, status: 'executed', satisfiedBy: 'human', approverType: 'USER',
  approverId: 'u9', expiresAt: NOW, decidedAt: NOW, settledAt: NOW, result: null, createdAt: NOW, ...over,
});

const payload = (over: Partial<ApprovalRequestChangedPayload> = {}): ApprovalRequestChangedPayload => ({
  requestId: 'a1', status: 'executed', projectId: 'p1', permissionKey: 'fleet.budget.override', requiredMode: 'agent',
  actorType: 'SYSTEM', actorId: 'budget', onBehalfOfType: null, onBehalfOfId: null, expiresAt: NOW.toISOString(), ...over,
});

function build(over: {
  link?: FleetApprovalAskRecord | null; view?: FleetApprovalRecord | null; request?: ApprovalRequestRecord | null;
  policy?: BudgetPolicyRecord | null;
} = {}) {
  const handlers = new Map<string, (payload: unknown) => Promise<void>>();
  const registry = { register: vi.fn((type: string, handler: (p: unknown) => Promise<void>) => handlers.set(type, handler)) };
  const store = {
    findByRequest: vi.fn(async () => (over.link === undefined ? link() : over.link)),
    findApproval: vi.fn(async () => (over.view === undefined ? view() : over.view)),
    setResolvedBy: vi.fn(async () => link()),
    setRecordedStatus: vi.fn(async () => link()),
  };
  const queries = { findById: vi.fn(async () => (over.request === undefined ? request() : over.request)) };
  const resolved = [{ approvalId: 'a1', status: 'approved' }];
  const closer = { recordResolved: vi.fn(async () => resolved) };
  const live = { publish: vi.fn() };
  const budgets = { findById: vi.fn(async () => over.policy === undefined ? { updatedById: 'u1' } : over.policy) };
  const txManager = { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) };
  const subscriber = new FleetAskEventsSubscriber(
    registry as never, store as never, queries as never, closer as never, live as never, budgets as never, txManager as never,
  );
  subscriber.onModuleInit();
  const handle = handlers.get(APPROVAL_REQUEST_CHANGED);
  if (handle === undefined) throw new Error('the subscriber did not register');
  return { handle, store, queries, closer, live, budgets, txManager };
}

describe('FleetAskEventsSubscriber (US-007 fix round 2, US-009)', () => {
  it.each(['rejected', 'executed', 'failed', 'expired'] as const)('records the fleet outputs of a settled %s ask', async (status) => {
    const { handle, store, closer, live } = build({ request: request({ status }) });

    await handle(payload({ status }));

    // An expiry has no decider: it answers to the system (its on-behalf-of user or the policy's editor).
    const actor = status === 'expired'
      ? { type: 'SYSTEM', id: 'system', responsibleUserId: 'u1' }
      : { type: 'USER', id: 'u9', responsibleUserId: 'u9' };
    expect(closer.recordResolved).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }), actor);
    expect(store.setRecordedStatus).toHaveBeenCalledWith('a1', status);
    // Published only once the outputs and the idempotency key committed.
    expect(live.publish).toHaveBeenCalledWith([{ approvalId: 'a1', status: 'approved' }]);
  });

  it.each(['pending', 'approved', 'cancelled'] as const)('skips the %s status, which the fleet writes itself', async (status) => {
    const { handle, store, closer } = build();

    await handle(payload({ status }));

    expect(store.findByRequest).not.toHaveBeenCalled();
    expect(closer.recordResolved).not.toHaveBeenCalled();
  });

  it('skips a non-fleet approval key', async () => {
    const { handle, store } = build();

    await handle(payload({ permissionKey: 'role.manage' }));

    expect(store.findByRequest).not.toHaveBeenCalled();
  });

  it('a redelivered event for the status the link already recorded writes nothing', async () => {
    const { handle, closer, store, live } = build({ link: link({ recordedStatus: 'executed' }) });

    await handle(payload({ status: 'executed' }));

    expect(closer.recordResolved).not.toHaveBeenCalled();
    expect(store.setRecordedStatus).not.toHaveBeenCalled();
    expect(live.publish).not.toHaveBeenCalled();
  });

  it('a fleet-key request with no link is ignored', async () => {
    const { handle, closer } = build({ link: null });

    await handle(payload());

    expect(closer.recordResolved).not.toHaveBeenCalled();
  });

  it('a malformed payload is skipped, never a crash the relay would retry forever', async () => {
    const { handle, store } = build();

    await expect(handle({ status: 'executed' })).resolves.toBeUndefined();
    expect(store.findByRequest).not.toHaveBeenCalled();
  });

  it('fills the link resolution the view derives while the column is still null', async () => {
    const { handle, store } = build();

    await handle(payload({ status: 'executed' }));
    expect(store.setResolvedBy).toHaveBeenCalledWith('a1', 'user');
  });

  it('an expired ask resolves the link timeout and answers to the ask’s on-behalf-of user', async () => {
    const { handle, store, closer } = build({
      link: link({ kind: 'bash' }), request: request({ status: 'expired', approverId: null, onBehalfOf: { type: 'USER', id: 'u7' } }),
    });

    await handle(payload({ status: 'expired' }));

    expect(store.setResolvedBy).toHaveBeenCalledWith('a1', 'timeout');
    expect(closer.recordResolved).toHaveBeenCalledWith(expect.anything(), { type: 'SYSTEM', id: 'system', responsibleUserId: 'u7' });
  });
});

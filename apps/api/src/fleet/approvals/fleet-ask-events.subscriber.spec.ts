import { Logger } from '@nestjs/common';
import { APPROVAL_REQUEST_CHANGED, type ApprovalRequestChangedPayload } from '../../approvals/approval-request-events';
import type { ApprovalDecisionRecord, ApprovalRequestRecord } from '../../approvals/domain/approval.domain';
import type { BudgetPolicyRecord } from '../budgets/domain/budget.domain';
import { FleetAskEventsSubscriber } from './fleet-ask-events.subscriber';
import type { ApprovalResolvedBy, FleetApprovalRecord } from './domain/approval.domain';
import type { FleetApprovalAskRecord } from './domain/fleet-approval-ask.domain';

const NOW = new Date('2026-10-02T10:00:00.000Z');

const link = (over: Partial<FleetApprovalAskRecord> = {}): FleetApprovalAskRecord => ({
  requestId: 'a1', kind: 'bash', projectId: 'p1', jobId: 'j1', leaseEpoch: 1, naxAskId: 'n1', budgetPolicyId: null,
  resolvedBy: null, outcome: null, pendingClose: null, recordedStatus: null, createdAt: NOW, updatedAt: NOW,
  ...over,
});
const view = (over: Partial<FleetApprovalRecord> = {}): FleetApprovalRecord => ({
  id: 'a1', type: 'nax_bash_escalate', status: 'approved', projectId: 'p1', jobId: 'j1', leaseEpoch: 1, naxAskId: 'n1',
  policyId: null, payload: {}, outcome: null, requestedAt: NOW, expiresAt: NOW, decision: 'allow', decidedById: 'u9',
  decidedAt: NOW, resolvedBy: 'user', comment: null, createdAt: NOW, updatedAt: NOW, ...over,
});
const request = (over: Partial<ApprovalRequestRecord> = {}): ApprovalRequestRecord => ({
  id: 'a1', permissionKey: 'fleet.job.shell.escalate', projectId: 'p1', actor: { type: 'SYSTEM', id: 'runner' }, onBehalfOf: null,
  origin: 'runner', correlationId: 'c1', input: {}, inputHash: 'h1', requiredMode: 'agent', policyId: null, onTimeout: 'reject',
  approverMustHoldAction: true, requireDistinctApprover: false, status: 'executed', satisfiedBy: 'human', approverType: 'USER',
  approverId: 'u9', expiresAt: NOW, decidedAt: NOW, settledAt: NOW, result: null, createdAt: NOW, ...over,
});
const decision = (over: Partial<ApprovalDecisionRecord> = {}): ApprovalDecisionRecord => ({
  id: 'd1', requestId: 'a1', deciderType: 'USER', deciderId: 'u9', decision: 'approve', comment: null, params: null,
  decidedAt: NOW, ...over,
});
const payload = (over: Partial<ApprovalRequestChangedPayload> = {}): ApprovalRequestChangedPayload => ({
  requestId: 'a1', status: 'executed', projectId: 'p1', permissionKey: 'fleet.job.shell.escalate', requiredMode: 'agent',
  actorType: 'SYSTEM', actorId: 'runner', onBehalfOfType: null, onBehalfOfId: null, expiresAt: NOW.toISOString(), ...over,
});

interface Overrides {
  link?: FleetApprovalAskRecord | null;
  view?: FleetApprovalRecord | null;
  request?: ApprovalRequestRecord | null;
  decisions?: ApprovalDecisionRecord[];
  policy?: BudgetPolicyRecord | null;
}

/**
 * The subscriber with every collaborator a spy: the link is mutable, so the recorder's own writes are
 * what a redelivery of the same event reads back, proving the marker suppresses further recording.
 */
function build(over: Overrides = {}) {
  const handlers = new Map<string, (p: unknown) => Promise<void>>();
  const registry = { register: vi.fn((type: string, handler: (p: unknown) => Promise<void>) => handlers.set(type, handler)) };
  let state: FleetApprovalAskRecord | null = over.link === undefined ? link() : over.link;
  const store = {
    lockByRequest: vi.fn(async () => state),
    findApproval: vi.fn(async () => (over.view === undefined ? view() : over.view)),
    setResolvedBy: vi.fn(async (_id: string, resolvedBy: ApprovalResolvedBy) => {
      state = state === null ? null : { ...state, resolvedBy };
      return state;
    }),
    setRecordedStatus: vi.fn(async (_id: string, recordedStatus: string) => {
      state = state === null ? null : { ...state, recordedStatus };
      return state;
    }),
  };
  const queries = {
    findById: vi.fn(async () => (over.request === undefined ? request() : over.request)),
    decisionsFor: vi.fn(async () => over.decisions ?? [decision()]),
  };
  const closer = { recordResolved: vi.fn(async () => undefined) };
  const budgets = { findById: vi.fn(async () => (over.policy === undefined ? { updatedById: 'u1' } : over.policy)) };
  const tx = {
    run: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
  const subscriber = new FleetAskEventsSubscriber(
    registry as never, store as never, queries as never, closer as never, budgets as never, tx as never,
  );
  subscriber.onModuleInit();
  const handle = handlers.get(APPROVAL_REQUEST_CHANGED);
  if (handle === undefined) throw new Error('the subscriber did not register');
  return { handle, store, queries, closer, budgets, tx };
}

describe('FleetAskEventsSubscriber (US-009)', () => {
  it('retired live AC-3: an already recorded executed status does not read or record again', async () => {
    const { handle, store, queries, closer } = build({ link: link({ recordedStatus: 'executed' }) });
    await handle(payload());
    expect(store.lockByRequest).toHaveBeenCalledWith('a1');
    expect(queries.findById).not.toHaveBeenCalled();
    expect(closer.recordResolved).not.toHaveBeenCalled();
  });

  it('retired live AC-1/2: recording a settlement returns void with no post-transaction publication work', async () => {
    const { handle, closer, tx } = build();
    await expect(handle(payload({ status: 'rejected' }))).resolves.toBeUndefined();
    expect(closer.recordResolved).toHaveBeenCalledTimes(1);
    expect(tx.run).toHaveBeenCalledTimes(1);
  });
  it('AC-6: a redelivered executed change records the outputs once', async () => {
    const { handle, store, closer } = build();

    await handle(payload({ status: 'executed' }));
    await handle(payload({ status: 'executed' }));

    // The second delivery sees the marker the first wrote, under the same link lock.
    expect(store.setRecordedStatus).toHaveBeenCalledTimes(1);
    expect(closer.recordResolved).toHaveBeenCalledTimes(1);
  });

  it('AC-7: a payload for ticket.delete writes nothing', async () => {
    const { handle, store, closer } = build();

    await handle(payload({ permissionKey: 'ticket.delete' }));

    expect(store.lockByRequest).not.toHaveBeenCalled();
    expect(closer.recordResolved).not.toHaveBeenCalled();
  });

  it('AC-8: a payload with status approved writes nothing', async () => {
    const { handle, store, closer } = build();

    await handle(payload({ status: 'approved' }));

    expect(store.lockByRequest).not.toHaveBeenCalled();
    expect(closer.recordResolved).not.toHaveBeenCalled();
  });

  it('AC-9: a malformed payload logs the warning and writes nothing', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
    const { handle, store, closer } = build();

    await expect(handle({ status: 'executed' })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('approval_request_changed: malformed payload skipped');
    expect(store.lockByRequest).not.toHaveBeenCalled();
    expect(closer.recordResolved).not.toHaveBeenCalled();
  });

  it('AC-10: a fleet-key payload whose request has no link writes nothing', async () => {
    const { handle, store, closer } = build({ link: null });

    await handle(payload({ status: 'executed' }));

    expect(store.findApproval).not.toHaveBeenCalled();
    expect(closer.recordResolved).not.toHaveBeenCalled();
  });

  it('AC-11: an executed job_ended ask records approval.cancelled and leaves resolvedBy job_ended', async () => {
    const { handle, store, closer } = build({
      link: link({ resolvedBy: 'job_ended' }), view: view({ status: 'cancelled', resolvedBy: 'job_ended' }),
    });

    await handle(payload({ status: 'executed' }));

    expect(store.setResolvedBy).not.toHaveBeenCalled();
    // The closer reads the status off the view, so the activity row is the cancelled one.
    expect(closer.recordResolved).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', status: 'cancelled' }), expect.anything());
  });

  it('AC-12: a fleet-key payload with status pending or cancelled writes nothing', async () => {
    const { handle, store, closer } = build();

    for (const status of ['pending', 'cancelled'] as const) await handle(payload({ status }));

    expect(store.lockByRequest).not.toHaveBeenCalled();
    expect(closer.recordResolved).not.toHaveBeenCalled();
  });

  it.each(['rejected', 'executed', 'failed'] as const)('records the %s ask and fills the link resolution user', async (status) => {
    const { handle, store, closer } = build({ request: request({ status }) });

    await handle(payload({ status }));

    expect(store.setResolvedBy).toHaveBeenCalledWith('a1', 'user');
    expect(store.setRecordedStatus).toHaveBeenCalledWith('a1', status);
    expect(closer.recordResolved).toHaveBeenCalledTimes(1);
  });

  it('attributes a decided ask to the last decision’s decider, not the request’s approver column', async () => {
    const { handle, queries, closer } = build({
      request: request({ approverId: 'u-settled' }),
      decisions: [decision({ id: 'd1', deciderId: 'u-first' }), decision({ id: 'd2', deciderId: 'u-last' })],
    });

    await handle(payload({ status: 'executed' }));

    expect(queries.decisionsFor).toHaveBeenCalledWith('a1');
    expect(closer.recordResolved).toHaveBeenCalledWith(expect.anything(), { type: 'USER', id: 'u-last', responsibleUserId: 'u-last' });
  });

  it('an agent decider is recorded as an AGENT, which the outbox relay context cannot infer', async () => {
    // The relay runs as `system:outbox`, so `FleetActivityService` sees no agent principal: the decision's own
    // `deciderType` has to travel with the actor.
    const { handle, closer } = build({ decisions: [decision({ deciderType: 'AGENT', deciderId: 'ag-1' })] });

    await handle(payload({ status: 'executed' }));

    expect(closer.recordResolved).toHaveBeenCalledWith(expect.anything(), { type: 'AGENT', id: 'ag-1', responsibleUserId: 'ag-1' });
  });

  it('an expired bash ask resolves the link timeout and answers to its on-behalf-of user', async () => {
    const { handle, store, closer, budgets } = build({
      request: request({ status: 'expired', approverId: null, onBehalfOf: { type: 'USER', id: 'u7' } }),
      view: view({ status: 'expired', resolvedBy: 'timeout' }),
    });

    await handle(payload({ status: 'expired' }));

    expect(store.setResolvedBy).toHaveBeenCalledWith('a1', 'timeout');
    expect(closer.recordResolved).toHaveBeenCalledWith(expect.anything(), { type: 'SYSTEM', id: 'system', responsibleUserId: 'u7' });
    expect(budgets.findById).not.toHaveBeenCalled();
  });

  it('an expired budget ask answers to the policy editor of its own link', async () => {
    const { handle, closer, budgets } = build({
      link: link({ kind: 'budget', budgetPolicyId: 'pol-1', jobId: null, leaseEpoch: null, naxAskId: null }),
      request: request({ status: 'expired', permissionKey: 'fleet.budget.override', approverId: null }),
      view: view({ type: 'budget_override_required', status: 'expired', policyId: 'pol-2' }),
    });

    await handle(payload({ status: 'expired', permissionKey: 'fleet.budget.override' }));

    // The link owns the policy the ask belongs to; the view's policy is a read-model projection.
    expect(budgets.findById).toHaveBeenCalledWith('pol-1');
    expect(closer.recordResolved).toHaveBeenCalledWith(expect.anything(), { type: 'SYSTEM', id: 'system', responsibleUserId: 'u1' });
  });

  it('an expired budget ask whose policy is gone records the system actor with no responsible user', async () => {
    const { handle, closer } = build({
      link: link({ kind: 'budget', budgetPolicyId: 'pol-gone', jobId: null }), policy: null,
      request: request({ status: 'expired', permissionKey: 'fleet.budget.override', approverId: null }),
    });

    await handle(payload({ status: 'expired', permissionKey: 'fleet.budget.override' }));

    expect(closer.recordResolved).toHaveBeenCalledWith(expect.anything(), { type: 'SYSTEM', id: 'system', responsibleUserId: null });
  });

  it('an expired bash ask with an agent requester records the system actor with no responsible user', async () => {
    const { handle, closer, budgets } = build({
      request: request({ status: 'expired', approverId: null, onBehalfOf: { type: 'AGENT', id: 'ag-1' } }),
    });

    await handle(payload({ status: 'expired' }));

    expect(budgets.findById).not.toHaveBeenCalled();
    expect(closer.recordResolved).toHaveBeenCalledWith(expect.anything(), { type: 'SYSTEM', id: 'system', responsibleUserId: null });
  });

  it('a delayed expiry event cannot reapply timeout to an ask the engine no longer holds expired', async () => {
    const { handle, store, closer } = build({
      request: request({ status: 'pending' }), view: view({ status: 'pending' }),
    });

    await handle(payload({ status: 'expired' }));

    expect(store.setResolvedBy).not.toHaveBeenCalled();
    expect(store.setRecordedStatus).not.toHaveBeenCalled();
    expect(closer.recordResolved).not.toHaveBeenCalled();
  });

  it('records a projectless ask too', async () => {
    const { handle, closer } = build({ view: view({ projectId: null }) });

    await handle(payload({ status: 'executed', projectId: null }));

    expect(closer.recordResolved).toHaveBeenCalledTimes(1);
  });

  it('a database failure propagates, so the relay retries the event', async () => {
    const { handle, store } = build();
    store.findApproval.mockRejectedValueOnce(new Error('db unavailable'));

    await expect(handle(payload({ status: 'executed' }))).rejects.toThrow('db unavailable');
  });
});

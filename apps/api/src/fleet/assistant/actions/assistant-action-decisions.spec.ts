/**
 * Fleet S5b 2a US-005: the decide handler's gate order, its reject and expire-on-decide writes, and the post-commit
 * publication. Every collaborator is a stub, so each assertion is about what the handler decides; the DB-backed
 * behaviour is in test/integration/fleet/assistant-actions-decide.integration.spec.ts.
 */
import { ForbiddenAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../../common/exceptions/conflict-app.exception';
import { testFleetConfig } from '../../../common/test-helpers/fleet-config';
import type { FleetApprovalRecord } from '../../approvals/domain/approval.domain';
import { AssistantActionDecisions } from './assistant-action-decisions';
import type { PendingActionRecord } from './pending-action.domain';

const NOW = new Date('2026-10-23T09:00:00.000Z');
const FUTURE = new Date(NOW.getTime() + 60_000);
const CALLER = { id: 'u1', globalAdmin: false };

const action = (over: Partial<PendingActionRecord> = {}): PendingActionRecord => ({
  id: 'act1', projectId: 'p1', projectSlug: 'web', threadId: 't1', jobId: 'j1', toolCallId: 'tc1', tool: 'koda_add_comment',
  input: {}, preview: 'p', status: 'PENDING', requestedById: 'u1', approvalId: 'ap1', decidedById: null, decidedAt: null,
  result: null, deliveredAt: null, expiresAt: FUTURE, createdAt: NOW, ...over,
});

const approval = (over: Partial<FleetApprovalRecord> = {}): FleetApprovalRecord => ({
  id: 'ap1', type: 'assistant_action', status: 'pending', projectId: 'p1', jobId: 'j1', leaseEpoch: null, naxAskId: null, policyId: null,
  payload: { actionId: 'act1', tool: 'koda_add_comment', threadId: 't1', threadPath: '/web/threads/t1', requestedById: 'u1' },
  outcome: null, requestedAt: NOW, expiresAt: FUTURE, decision: null, decidedById: null, decidedAt: null, resolvedBy: null,
  comment: null, createdAt: NOW, updatedAt: NOW, ...over,
});

function build(opts: { stored?: PendingActionRecord | null; threadsEnabled?: boolean } = {}) {
  let row: PendingActionRecord | null = opts.stored === undefined ? action() : opts.stored;
  const order: string[] = [];
  const actions = {
    findById: vi.fn(async () => row),
    lockThread: vi.fn(async () => { order.push('thread'); return true; }),
    lockById: vi.fn(async () => { order.push('action'); return row; }),
    resolve: vi.fn(async (_id: string, r: Partial<PendingActionRecord>) => (row = { ...(row as PendingActionRecord), ...r })),
    insertSystemNote: vi.fn(async () => 'note1'),
  };
  const approvals = {
    lockById: vi.fn(async () => { order.push('approval'); return approval(); }),
    resolve: vi.fn(async (_id: string, r: Partial<FleetApprovalRecord>) => approval(r)),
  };
  const closer = { recordResolved: vi.fn(async () => [{ id: 'live1' }]) };
  const live = { publish: vi.fn() };
  const threads = { publish: vi.fn() };
  const tx = { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) };
  const port = { register: vi.fn() };
  const cfg = testFleetConfig({ threadsEnabled: opts.threadsEnabled ?? true });
  const service = new AssistantActionDecisions(tx as never, actions as never, approvals as never, closer as never, live as never, threads as never, cfg as never, port as never);
  return { service, actions, approvals, closer, live, threads, tx, port, order };
}

const dto = (decision: string) => ({ decision }) as never;

describe('AssistantActionDecisions.decide gates (2a-D8)', () => {
  it('registers itself with the port on init', () => {
    const { service, port } = build();
    service.onModuleInit();
    expect(port.register).toHaveBeenCalledWith(service);
  });

  it('answers 409 fleet.approvalNotPending when the action row is gone', async () => {
    const { service, tx } = build({ stored: null });
    await expect(service.decide(CALLER, approval(), dto('reject'), NOW)).rejects.toMatchObject({ prefix: 'fleet.approvalNotPending', httpStatus: 409 });
    expect(tx.run).not.toHaveBeenCalled();
  });

  it('answers 403 threads.notCreator to anyone but the payload requester, before the decision is validated', async () => {
    const { service, tx } = build();
    const other = { id: 'u2', globalAdmin: true };
    const err = await service.decide(other, approval(), dto('allow'), NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenAppException);
    expect(err).toMatchObject({ prefix: 'threads.notCreator', httpStatus: 403 });
    expect(tx.run).not.toHaveBeenCalled();
  });

  it('answers 400 fleet.approvalDecisionInvalid for a decision that is not approve or reject', async () => {
    const { service, tx } = build();
    const err = await service.decide(CALLER, approval(), dto('allow'), NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationAppException);
    expect(err).toMatchObject({ prefix: 'fleet.approvalDecisionInvalid', args: { reason: 'allow does not apply to an assistant action' } });
    expect(tx.run).not.toHaveBeenCalled();
  });

  it('AC-12: answers 409 threads.disabled when FLEET_THREADS_ENABLED is off', async () => {
    const { service } = build({ threadsEnabled: false });
    const err = await service.decide(CALLER, approval(), dto('reject'), NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictAppException);
    expect(err).toMatchObject({ prefix: 'threads.disabled', httpStatus: 409 });
  });

  it('AC-13: writes nothing and publishes nothing when FLEET_THREADS_ENABLED is off', async () => {
    const { service, tx, actions, approvals, closer, live, threads } = build({ threadsEnabled: false });
    await service.decide(CALLER, approval(), dto('reject'), NOW).catch(() => undefined);
    expect(tx.run).not.toHaveBeenCalled();
    for (const write of [actions.lockThread, actions.resolve, actions.insertSystemNote, approvals.resolve, closer.recordResolved, live.publish, threads.publish]) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it('a decision that is not approve or reject is refused before the flag is read', async () => {
    const { service } = build({ threadsEnabled: false });
    await expect(service.decide(CALLER, approval(), dto('deny'), NOW)).rejects.toMatchObject({ prefix: 'fleet.approvalDecisionInvalid' });
  });
});

describe('AssistantActionDecisions.decide locked checks and reject', () => {
  it('locks the thread, then the approval, then the action (2a-D11)', async () => {
    const { service, order } = build();
    await service.decide(CALLER, approval(), dto('reject'), NOW);
    expect(order).toEqual(['thread', 'approval', 'action']);
  });

  it('answers 409 when the thread is gone, writing nothing', async () => {
    const { service, actions } = build();
    actions.lockThread.mockResolvedValue(false);
    await expect(service.decide(CALLER, approval(), dto('reject'), NOW)).rejects.toMatchObject({ prefix: 'fleet.approvalNotPending' });
    expect(actions.resolve).not.toHaveBeenCalled();
  });

  it('answers 409 and writes nothing when the approval is no longer pending', async () => {
    const { service, approvals, actions, threads } = build();
    approvals.lockById.mockResolvedValue(approval({ status: 'rejected' }));
    await expect(service.decide(CALLER, approval(), dto('reject'), NOW)).rejects.toMatchObject({ prefix: 'fleet.approvalNotPending', httpStatus: 409 });
    expect(actions.resolve).not.toHaveBeenCalled();
    expect(threads.publish).not.toHaveBeenCalled();
  });

  it('answers 409 and writes nothing when the action is no longer PENDING', async () => {
    const { service, actions } = build({ stored: action({ status: 'REJECTED' }) });
    await expect(service.decide(CALLER, approval(), dto('reject'), NOW)).rejects.toMatchObject({ prefix: 'fleet.approvalNotPending' });
    expect(actions.resolve).not.toHaveBeenCalled();
    expect(actions.insertSystemNote).not.toHaveBeenCalled();
  });

  it('approve is refused until US-006 and never takes the reject path', async () => {
    const { service, actions, approvals, threads } = build();
    await expect(service.decide(CALLER, approval(), dto('approve'), NOW)).rejects.toMatchObject({ prefix: 'fleet.approvalDecisionInvalid' });
    expect(actions.resolve).not.toHaveBeenCalled();
    expect(approvals.resolve).not.toHaveBeenCalled();
    expect(threads.publish).not.toHaveBeenCalled();
  });

  it('reject resolves the approval, sets the action REJECTED and writes the note', async () => {
    const { service, approvals, actions, closer } = build();

    const result = await service.decide(CALLER, approval(), { decision: 'reject', comment: 'no thanks' }, NOW);

    expect(approvals.resolve).toHaveBeenCalledWith('ap1', {
      status: 'rejected', resolvedBy: 'user', decidedAt: NOW, decision: 'reject', decidedById: 'u1', comment: 'no thanks',
    });
    expect(actions.resolve).toHaveBeenCalledWith('act1', { status: 'REJECTED', decidedById: 'u1', decidedAt: NOW });
    expect(actions.insertSystemNote).toHaveBeenCalledWith('t1', 'Action act1 (koda_add_comment) was rejected by the user.');
    expect(closer.recordResolved).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected' }), { type: 'USER', id: 'u1', responsibleUserId: 'u1' });
    expect(result).toEqual(expect.objectContaining({ status: 'rejected', decision: 'reject' }));
  });

  it('AC-19: after the commit publishes the approval live events and a message event naming the note, then a thread event', async () => {
    const { service, live, threads, tx } = build();
    let committed = false;
    tx.run.mockImplementation(async (fn: () => Promise<unknown>) => { const r = await fn(); committed = true; return r; });
    live.publish.mockImplementation(() => expect(committed).toBe(true));
    threads.publish.mockImplementation(() => expect(committed).toBe(true));

    await service.decide(CALLER, approval(), dto('reject'), NOW);

    expect(live.publish).toHaveBeenCalledWith([{ id: 'live1' }]);
    expect(threads.publish.mock.calls.map(([e]) => e)).toEqual([
      expect.objectContaining({ threadId: 't1', at: NOW.toISOString(), type: 'message', messageId: 'note1' }),
      expect.objectContaining({ threadId: 't1', at: NOW.toISOString(), type: 'thread' }),
    ]);
    expect(threads.publish.mock.calls[0][0].id).toEqual(expect.any(String));
  });

  it('publishes nothing when the transaction fails', async () => {
    const { service, live, threads, tx } = build();
    tx.run.mockRejectedValue(new Error('commit failed'));
    await expect(service.decide(CALLER, approval(), dto('reject'), NOW)).rejects.toThrow('commit failed');
    expect(live.publish).not.toHaveBeenCalled();
    expect(threads.publish).not.toHaveBeenCalled();
  });
});

describe('AssistantActionDecisions expiry on decide (2a-D10)', () => {
  it('AC-16/17: past expiresAt expires the action and approval, writes the note, then answers 409 after the commit', async () => {
    const { service, actions, approvals, closer, live, threads, tx } = build({ stored: action({ expiresAt: NOW }) });
    let committed = false;
    tx.run.mockImplementation(async (fn: () => Promise<unknown>) => { const r = await fn(); committed = true; return r; });

    const err = await service.decide(CALLER, approval({ expiresAt: NOW }), dto('reject'), NOW).catch((e: unknown) => e);

    expect(committed).toBe(true);
    expect(err).toMatchObject({ prefix: 'fleet.approvalNotPending', httpStatus: 409 });
    expect(actions.resolve).toHaveBeenCalledWith('act1', { status: 'EXPIRED', decidedAt: NOW });
    expect(approvals.resolve).toHaveBeenCalledWith('ap1', { status: 'expired', resolvedBy: 'timeout', decidedAt: NOW });
    expect(closer.recordResolved).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }), { type: 'SYSTEM', id: 'system', responsibleUserId: 'u1' });
    expect(actions.insertSystemNote).toHaveBeenCalledWith('t1', 'Action act1 (koda_add_comment) expired without a decision.');
    expect(live.publish).toHaveBeenCalled();
    expect(threads.publish.mock.calls.map(([e]) => e.type)).toEqual(['message', 'thread']);
  });

  it('an expiresAt after now is not expired', async () => {
    const { service, actions } = build({ stored: action({ expiresAt: new Date(NOW.getTime() + 1) }) });
    await service.decide(CALLER, approval(), dto('reject'), NOW);
    expect(actions.resolve).toHaveBeenCalledWith('act1', expect.objectContaining({ status: 'REJECTED' }));
  });

  it('a null approval expiresAt falls back to the action expiresAt', async () => {
    const { service, actions } = build({ stored: action({ expiresAt: NOW }) });
    await expect(service.decide(CALLER, approval({ expiresAt: null }), dto('reject'), NOW)).rejects.toMatchObject({ prefix: 'fleet.approvalNotPending' });
    expect(actions.resolve).toHaveBeenCalledWith('act1', { status: 'EXPIRED', decidedAt: NOW });
  });
});

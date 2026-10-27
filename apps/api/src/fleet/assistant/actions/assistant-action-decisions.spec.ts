/**
 * Fleet S5b 2a US-005: the decide handler's gate order, its reject and expire-on-decide writes, and the post-commit
 * publication. US-006 extends the same handler with the approve branch: its re-check before the locked checks, the
 * APPROVED/finalize transaction pair and the capped result. Every collaborator is a stub, so each assertion is about
 * what the handler decides; the DB-backed behaviour is in
 * test/integration/fleet/assistant-actions-decide.integration.spec.ts and
 * test/integration/fleet/assistant-actions-approve.integration.spec.ts.
 */
import { ForbiddenAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../../common/exceptions/conflict-app.exception';
import { currentBookkeepingReason } from '../../../action-context/audit-coverage';
import { testFleetConfig } from '../../../common/test-helpers/fleet-config';
import { mockAuditRecorder } from '../../../common/test-helpers/global-stubs.module';
import type { PermissionService } from '../../../permissions/permission.service';
import type { FleetApprovalRecord } from '../../approvals/domain/approval.domain';
import { AssistantToolExecutor, type ActionOutcome } from '../assistant-tool.executor';
import { AssistantToolRegistry } from '../assistant-tool.registry';
import type { AssistantTool, ToolContext } from '../assistant-tool.types';
import { AssistantActionDecisions } from './assistant-action-decisions';
import type { PendingActionRecord } from './pending-action.domain';

const NOW = new Date('2026-10-23T09:00:00.000Z');
const FUTURE = new Date(NOW.getTime() + 60_000);
const CALLER = { id: 'u1' };

const action = (over: Partial<PendingActionRecord> = {}): PendingActionRecord => ({
  actorType: 'user', actorId: 'u1', origin: 'thread', approvalMode: 'human', approverType: null, approverId: null,
  id: 'act1', projectId: 'p1', projectSlug: 'web', threadId: 't1', jobId: 'j1', toolCallId: 'tc1', tool: 'koda_add_comment',
  input: {}, preview: 'p', status: 'PENDING', approvalId: 'ap1', decidedAt: null,
  result: null, deliveredAt: null, expiresAt: FUTURE, createdAt: NOW, ...over,
});

const approval = (over: Partial<FleetApprovalRecord> = {}): FleetApprovalRecord => ({
  id: 'ap1', type: 'assistant_action', status: 'pending', projectId: 'p1', jobId: 'j1', leaseEpoch: null, naxAskId: null, policyId: null,
  payload: { actionId: 'act1', tool: 'koda_add_comment', threadId: 't1', threadPath: '/web/threads/t1', requestedById: 'u1' },
  outcome: null, requestedAt: NOW, expiresAt: FUTURE, decision: null, decidedById: null, decidedAt: null, resolvedBy: null,
  comment: null, createdAt: NOW, updatedAt: NOW, ...over,
});

function build(opts: { stored?: PendingActionRecord | null; threadsEnabled?: boolean; check?: 'ok' | 'forbidden'; outcome?: ActionOutcome; executor?: AssistantToolExecutor } = {}) {
  let row: PendingActionRecord | null = opts.stored === undefined ? action() : opts.stored;
  const order: string[] = [];
  const actions = {
    findById: vi.fn(async (_id: string) => row),
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
  const auditOrder: string[] = [];
  const audit = mockAuditRecorder;
  vi.spyOn(audit, 'record').mockReset().mockImplementation(async () => { auditOrder.push('record'); });
  const tx = { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) };
  const port = { register: vi.fn() };
  const cfg = testFleetConfig({ threadsEnabled: opts.threadsEnabled ?? true });
  const executor = opts.executor ?? {
    checkAction: vi.fn(async () => opts.check ?? 'ok'),
    executeAction: vi.fn(async (): Promise<ActionOutcome> => opts.outcome ?? { ok: true, text: 'comment c1 added to KODA-1 /web/tickets/KODA-1' }),
  };
  const service = new AssistantActionDecisions(tx as never, actions as never, approvals as never, closer as never, live as never, threads as never, cfg as never, port as never, executor as never, audit as never);
  return { service, actions, approvals, closer, live, threads, tx, port, order, executor, audit, auditOrder };
}

/**
 * The real executor an approve runs the tool with: one registered tool, a job whose thread creator is `u1`, and a
 * membership that answers DEVELOPER. It is what makes the cap (AC-18) and the tool-never-runs regression (AC-28)
 * assertions about the shipped code rather than about a stub. 3-D12: its `findUserActor` answers the requester the
 * action fixtures name, exactly as the real repository would.
 */
function realExecutor(tool: AssistantTool<unknown>): AssistantToolExecutor {
  const registry = new AssistantToolRegistry();
  registry.register(tool);
  const calls = { findAgentActor: vi.fn(async () => null), findProjectSlug: vi.fn(async () => null),
    findUserActor: vi.fn(async () => CONTEXT.creator), findCallContext: vi.fn(async () => CONTEXT) };
  const access = { resolveMembership: vi.fn(async () => 'DEVELOPER') };
  // Permissions P1 US-004: the approve re-checks the action's key through `PermissionService`; every key is allowed
  // here, so the cases stay about the decide handler's own refusals.
  const permissions = { can: vi.fn(async () => ({ allowed: true, reason: 'granted' })) } as unknown as PermissionService;
  return new AssistantToolExecutor(registry, calls as never, access as never, permissions);
}

const CONTEXT = {
  project: { id: 'p1', slug: 'web' }, threadId: 't1',
  creator: { id: 'u1', email: 'u1@koda.test', role: 'MEMBER', disabled: false },
};

const commentTool = (execute: (ctx: ToolContext, input: unknown) => Promise<string>): AssistantTool<unknown> => ({
  descriptor: { name: 'koda_add_comment', description: 'd', inputSchema: {} },
  key: 'comment.create',
  parse: (input) => input,
  execute,
});

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
    const other = { id: 'u2' };
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

  it('reject resolves the approval, sets the action REJECTED and writes the note', async () => {
    const { service, approvals, actions, closer } = build();

    const result = await service.decide(CALLER, approval(), { decision: 'reject', comment: 'no thanks' }, NOW);

    expect(approvals.resolve).toHaveBeenCalledWith('ap1', {
      status: 'rejected', resolvedBy: 'user', decidedAt: NOW, decision: 'reject', decidedById: 'u1', comment: 'no thanks',
    });
    expect(actions.resolve).toHaveBeenCalledWith('act1', { status: 'REJECTED', approverId: 'u1', decidedAt: NOW });
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

describe('AssistantActionDecisions approve (2a-D8 step 8)', () => {
  it('AC-10: records the approval decision inside settle before executing the action', async () => {
    const { service, audit, auditOrder, tx, executor } = build();
    let inTransaction = false;
    tx.run.mockImplementation(async (fn: () => Promise<unknown>) => {
      inTransaction = true;
      try { return await fn(); } finally { inTransaction = false; }
    });
    audit.record.mockImplementation(async (input: unknown) => {
      expect(inTransaction).toBe(true);
      expect(input).toMatchObject({ key: 'fleet.approval.decide.assistant', resourceType: 'fleet-approval', resourceId: 'ap1', projectId: 'p1', summary: 'decision: approve' });
      auditOrder.push('record');
    });
    executor.executeAction.mockImplementation(async () => {
      auditOrder.push('execute');
      return { ok: true, text: 'done' };
    });

    await service.decide(CALLER, approval(), dto('approve'), NOW);

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(auditOrder).toEqual(['record', 'execute']);
  });

  it('AC-14: a forbidden checkAction answers 403 projects and writes nothing', async () => {
    const { service, actions, approvals, tx, executor, threads } = build({ check: 'forbidden' });

    const err = await service.decide(CALLER, approval(), dto('approve'), NOW).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ForbiddenAppException);
    expect(err).toMatchObject({ prefix: 'projects', httpStatus: 403 });
    expect(executor.checkAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'act1' }));
    expect(tx.run).not.toHaveBeenCalled();
    expect(actions.resolve).not.toHaveBeenCalled();
    expect(approvals.resolve).not.toHaveBeenCalled();
    expect(executor.executeAction).not.toHaveBeenCalled();
    expect(threads.publish).not.toHaveBeenCalled();
    // The action the handler read before the check is the one that stays PENDING.
    expect(await actions.findById('act1')).toMatchObject({ status: 'PENDING' });
  });

  it('checks the approve before the locked status checks, so a decided action is still 403 for a forbidden requester', async () => {
    const { service, tx } = build({ stored: action({ status: 'EXECUTED' }), check: 'forbidden' });

    await expect(service.decide(CALLER, approval(), dto('approve'), NOW)).rejects.toMatchObject({ prefix: 'projects', httpStatus: 403 });
    expect(tx.run).not.toHaveBeenCalled();
  });

  it('approves the approval, sets the action APPROVED, runs the tool and finalizes EXECUTED', async () => {
    const { service, actions, approvals, closer, live, threads, order, executor } = build();

    const result = await service.decide(CALLER, approval(), { decision: 'approve', comment: 'ship it' }, NOW);

    expect(approvals.resolve).toHaveBeenCalledWith('ap1', {
      status: 'approved', resolvedBy: 'user', decidedAt: NOW, decision: 'approve', decidedById: 'u1', comment: 'ship it',
    });
    expect(actions.resolve).toHaveBeenCalledWith('act1', { status: 'APPROVED', approverId: 'u1', decidedAt: NOW });
    expect(closer.recordResolved).toHaveBeenCalledWith(expect.objectContaining({ status: 'approved', decision: 'approve' }), { type: 'USER', id: 'u1', responsibleUserId: 'u1' });
    expect(executor.executeAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'act1', projectSlug: 'web' }));
    expect(actions.resolve).toHaveBeenCalledWith('act1', expect.objectContaining({ status: 'EXECUTED', result: 'comment c1 added to KODA-1 /web/tickets/KODA-1' }));
    expect(actions.insertSystemNote).toHaveBeenCalledWith('t1', 'Action act1 (koda_add_comment) was approved and done: comment c1 added to KODA-1 /web/tickets/KODA-1');
    expect(live.publish).toHaveBeenCalledWith([{ id: 'live1' }]);
    expect(result).toEqual(expect.objectContaining({ status: 'approved', decision: 'approve' }));
  });

  it('2a-D11: both transactions take the thread lock, then the approval, then the action', async () => {
    const { service, order } = build();

    await service.decide(CALLER, approval(), dto('approve'), NOW);

    expect(order).toEqual(['thread', 'approval', 'action', 'thread', 'action']);
  });

  it('AC-22: after the approve the thread bus carries the note message and the changed thread', async () => {
    const { service, threads, tx } = build();
    let commits = 0;
    tx.run.mockImplementation(async (fn: () => Promise<unknown>) => { const r = await fn(); commits += 1; return r; });
    // Both frames belong to the finalization transaction, which is the one that created the note.
    threads.publish.mockImplementation(() => expect(commits).toBe(2));

    await service.decide(CALLER, approval(), dto('approve'), NOW);

    expect(threads.publish.mock.calls.map(([e]) => e)).toEqual([
      expect.objectContaining({ threadId: 't1', at: NOW.toISOString(), type: 'message', messageId: 'note1' }),
      expect.objectContaining({ threadId: 't1', at: NOW.toISOString(), type: 'thread' }),
    ]);
    expect(threads.publish.mock.calls[0][0].id).toEqual(expect.any(String));
  });

  it('the approval live events are published after the approve commit, before the note is written', async () => {
    const { service, live, threads } = build();
    live.publish.mockImplementation(() => expect(threads.publish).not.toHaveBeenCalled());

    await service.decide(CALLER, approval(), dto('approve'), NOW);

    expect(live.publish).toHaveBeenCalledTimes(1);
  });

  it('answers the approved approval when the tool failed, and the action becomes FAILED with the error text', async () => {
    const { service, actions, approvals, live, threads } = build({ outcome: { ok: false, text: 'not_found' } });

    const result = await service.decide(CALLER, approval(), dto('approve'), NOW);

    // The approval was already approved and cannot be un-approved; only the action records the failure.
    expect(approvals.resolve).toHaveBeenCalledWith('ap1', expect.objectContaining({ status: 'approved' }));
    expect(actions.resolve).toHaveBeenCalledWith('act1', expect.objectContaining({ status: 'FAILED', result: 'not_found' }));
    expect(actions.insertSystemNote).toHaveBeenCalledWith('t1', 'Action act1 (koda_add_comment) was approved but failed: not_found');
    expect(result).toEqual(expect.objectContaining({ status: 'approved' }));
    expect(live.publish).toHaveBeenCalled();
    expect(threads.publish.mock.calls.map(([e]) => e.type)).toEqual(['message', 'thread']);
  });

  it('a thread that is gone still answers the approved approval, writing no note', async () => {
    const { service, actions, threads } = build();
    let locks = 0;
    actions.lockThread.mockImplementation(async () => ++locks < 2);

    expect(await service.decide(CALLER, approval(), dto('approve'), NOW)).toEqual(expect.objectContaining({ status: 'approved' }));
    expect(actions.insertSystemNote).not.toHaveBeenCalled();
    expect(threads.publish).not.toHaveBeenCalled();
  });

  it('AC-18: a 20000-byte tool result is stored capped at 16384 bytes', async () => {
    const { service, actions } = build({ executor: realExecutor(commentTool(async () => 'x'.repeat(20_000))) });

    await service.decide(CALLER, approval(), dto('approve'), NOW);

    const settled = actions.resolve.mock.calls.find(([, r]) => r.status === 'EXECUTED')?.[1] as Partial<PendingActionRecord>;
    const result = String(settled.result);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(16_384);
    expect(result.endsWith('[truncated]')).toBe(true);
    expect(actions.insertSystemNote).toHaveBeenCalledWith('t1', expect.stringContaining('was approved and done: x'));
  });

  it('AC-18 boundary: an over-cap outcome is clamped at the row, whatever answered it', async () => {
    const { service, actions } = build({ outcome: { ok: true, text: 'x'.repeat(20_000) } });

    await service.decide(CALLER, approval(), dto('approve'), NOW);

    const settled = actions.resolve.mock.calls.find(([, r]) => r.status === 'EXECUTED')?.[1] as Partial<PendingActionRecord>;
    expect(Buffer.byteLength(String(settled.result))).toBeLessThanOrEqual(16_384);
    expect(String(settled.result).endsWith('[truncated]')).toBe(true);
  });

  it('AC-28: a reject never runs the tool', async () => {
    const execute = vi.fn(async () => 'comment c1 added to KODA-1');
    const executor = realExecutor(commentTool(execute));
    const run = vi.spyOn(executor, 'executeAction');
    const { service, actions, approvals } = build({ executor });

    await service.decide(CALLER, approval(), { decision: 'reject', comment: 'not now' }, NOW);

    expect(execute).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(actions.resolve).toHaveBeenCalledWith('act1', { status: 'REJECTED', approverId: 'u1', decidedAt: NOW });
    expect(approvals.resolve).toHaveBeenCalledWith('ap1', expect.objectContaining({ status: 'rejected', decision: 'reject' }));
  });

  it('an expired approve never runs the tool', async () => {
    const executor = realExecutor(commentTool(vi.fn(async () => 'comment c1')));
    const run = vi.spyOn(executor, 'executeAction');
    const { service } = build({ executor, stored: action({ expiresAt: NOW }) });

    await expect(service.decide(CALLER, approval(), dto('approve'), NOW)).rejects.toMatchObject({ prefix: 'fleet.approvalNotPending' });
    expect(run).not.toHaveBeenCalled();
  });
});

/**
 * Permissions P2 US-007: the tool itself is the domain write, so it runs counted; only the terminal settle that follows
 * it — the action's final status and the outcome note — is bookkeeping.
 */
describe('AssistantActionDecisions audit coverage (permissions P2 US-007)', () => {
  type Reason = ReturnType<typeof currentBookkeepingReason>;

  /** Records the bookkeeping reason current at each call of a stub, then answers exactly as the stub did. */
  function watching<T>(fn: T, seen: Reason[]): T {
    const mock = fn as unknown as {
      getMockImplementation(): ((...args: never[]) => unknown) | undefined;
      mockImplementation(impl: (...args: never[]) => unknown): void;
    };
    const impl = mock.getMockImplementation();
    mock.mockImplementation((...args: never[]) => {
      seen.push(currentBookkeepingReason());
      return impl?.(...args);
    });
    return fn;
  }

  it('AC-12: the approved action runs its tool while currentBookkeepingReason() answers undefined', async () => {
    const { service, executor } = build();
    const seen: Reason[] = [];
    watching(executor.executeAction, seen);

    await service.decide(CALLER, approval(), dto('approve'), NOW);

    expect(executor.executeAction).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([undefined]);
  });

  it('AC-13: the terminal EXECUTED resolve and the note are written under assistant.action-finalize, after the tool', async () => {
    const { service, actions, executor } = build();
    const reasons: Reason[] = [];
    const statuses: Array<string | undefined> = [];
    const impl = actions.resolve.getMockImplementation() as (id: string, r: Partial<PendingActionRecord>) => Promise<PendingActionRecord>;
    actions.resolve.mockImplementation(async (id: string, r: Partial<PendingActionRecord>) => {
      reasons.push(currentBookkeepingReason());
      statuses.push(r.status);
      return impl(id, r);
    });
    const noteReasons: Reason[] = [];
    watching(actions.insertSystemNote, noteReasons);

    await service.decide(CALLER, approval(), dto('approve'), NOW);

    // The approval's own APPROVED resolve is not part of the marker; the terminal settle is.
    expect(statuses).toEqual(['APPROVED', 'EXECUTED']);
    expect(reasons).toEqual([undefined, 'assistant.action-finalize']);
    expect(noteReasons).toEqual(['assistant.action-finalize']);
    expect(executor.executeAction.mock.invocationCallOrder[0]).toBeLessThan(actions.resolve.mock.invocationCallOrder[1]);
  });

  it('AC-13: a failing tool finalizes FAILED under the same reason', async () => {
    const { service, actions } = build({ outcome: { ok: false, text: 'not_found' } });
    const reasons: Reason[] = [];
    const statuses: Array<string | undefined> = [];
    const impl = actions.resolve.getMockImplementation() as (id: string, r: Partial<PendingActionRecord>) => Promise<PendingActionRecord>;
    actions.resolve.mockImplementation(async (id: string, r: Partial<PendingActionRecord>) => {
      reasons.push(currentBookkeepingReason());
      statuses.push(r.status);
      return impl(id, r);
    });

    await service.decide(CALLER, approval(), dto('approve'), NOW);

    expect(statuses).toEqual(['APPROVED', 'FAILED']);
    expect(reasons).toEqual([undefined, 'assistant.action-finalize']);
  });

  it('leaves no reason current once the decide has resolved', async () => {
    const { service } = build();

    await service.decide(CALLER, approval(), dto('approve'), NOW);

    expect(currentBookkeepingReason()).toBeUndefined();
  });
});

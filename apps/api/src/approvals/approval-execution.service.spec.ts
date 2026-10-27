import { Logger } from '@nestjs/common';
import { FleetJobLivePublisher } from '../fleet/jobs/fleet-job-live.publisher';
import { RunnerNotifier } from '../fleet/jobs/runner-notifier';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import { currentContext, type ActionContext } from '../action-context/action-context';
import { currentBookkeepingReason } from '../action-context/audit-coverage';
import type { PermissionService } from '../permissions/permission.service';
import { ApprovalCommandRegistry } from './approval-command.registry';
import { ApprovalExecutionService } from './approval-execution.service';
import { approvalInputHash } from './approval-input';
import type { ApprovalDecisionRecord, ApprovalRequestRecord } from './domain/approval.domain';
import { ApprovalRequestNotPendingError } from './domain/approval.errors';
import type { PrismaApprovalRequestRepository } from './prisma-approval-request.repository';
import { configurableTestCommand } from './test-helpers/test-approval-command';

const now = new Date('2026-11-05T09:00:00Z');
const input = { labelId: 'l1' };

function approved(patch: Partial<ApprovalRequestRecord> = {}): ApprovalRequestRecord {
  return {
    id: 'r1', permissionKey: 'label.delete', projectId: 'p1', actor: { type: 'AGENT', id: 'a1' },
    onBehalfOf: null, origin: 'mcp', correlationId: 'corr-1', input, inputHash: approvalInputHash(input),
    requiredMode: 'agent', policyId: null, onTimeout: 'reject', approverMustHoldAction: true,
    requireDistinctApprover: false, status: 'approved', satisfiedBy: 'human', approverType: 'USER', approverId: 'u1',
    expiresAt: new Date(now.getTime() + 1000), decidedAt: now, settledAt: null, result: null, createdAt: now, ...patch,
  };
}

function approving(patch: Partial<ApprovalDecisionRecord> = {}): ApprovalDecisionRecord {
  return {
    id: 'd1', requestId: 'r1', deciderType: 'USER', deciderId: 'u1', decision: 'approve',
    comment: null, decidedAt: now, params: null, ...patch,
  };
}

function setup(patch: Partial<ApprovalRequestRecord> = {}) {
  const request = approved(patch);
  const state = { current: request };
  const reasons: Array<string | undefined> = [];
  const repo = {
    findById: vi.fn().mockImplementation(async () => state.current),
    lockById: vi.fn().mockImplementation(async () => state.current),
    findDecisions: vi.fn().mockResolvedValue([]),
    transition: vi.fn().mockImplementation(async (_id: string, _from: string, p: Partial<ApprovalRequestRecord>) => {
      reasons.push(currentBookkeepingReason());
      return { ...state.current, ...p };
    }),
  };
  const permissions = { effectiveKeys: vi.fn().mockResolvedValue(new Set(['label.delete'])) };
  const tx = { run: vi.fn((fn: () => Promise<unknown>) => fn()), getClient: vi.fn(), isInTransaction: vi.fn(() => true) };
  const registry = new ApprovalCommandRegistry();
  const test = configurableTestCommand('label.delete');
  registry.register(test.command);
  const events = { record: vi.fn().mockImplementation(async () => { reasons.push(currentBookkeepingReason()); }) };
  const service = new ApprovalExecutionService(tx as unknown as ITransactionManager,
    repo as unknown as PrismaApprovalRequestRepository, permissions as unknown as PermissionService, registry, events as never);
  return { request, state, repo, permissions, tx, registry, test, service, events, reasons };
}

describe('ApprovalExecutionService', () => {
  it('runs the command under the request context and settles it executed', async () => {
    const s = setup({ onBehalfOf: null });
    let seen: ActionContext | undefined;
    const run = s.test.command.execute;
    s.test.command.execute = async (value) => { seen = currentContext(); return run(value); };
    s.test.state.toResult = () => ({ deleted: 1 });

    const settled = await s.service.execute('r1', now);

    expect(s.test.state.calls).toEqual([{ labelId: 'l1' }]);
    expect(settled).toMatchObject({ status: 'executed', settledAt: now, result: { deleted: 1 } });
    expect(s.events.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'r1', status: 'executed' }));
    expect(seen).toEqual({
      actor: { type: 'AGENT', id: 'a1' }, origin: 'mcp', correlationId: 'corr-1',
      approval: { requiredMode: 'agent', satisfiedBy: 'human', approverType: 'USER', approverId: 'u1', requestId: 'r1' },
    });
    expect(s.repo.transition).toHaveBeenCalledExactlyOnceWith('r1', 'approved', { status: 'executed', settledAt: now, result: { deleted: 1 } });
    expect(s.reasons).toEqual(['approval.request-settle', 'approval.request-settle']);
  });

  it.each(['commit', 'rollback', 'commit-failure'] as const)('fleet publications and runner wakes follow settlement %s', async (outcome) => {
    const s = setup();
    const project = { publish: vi.fn() };
    const threads = { publish: vi.fn() };
    const publisher = new FleetJobLivePublisher(project as never, threads as never);
    const notifier = new RunnerNotifier();
    const woke = vi.fn();
    const waiting = notifier.wait('runner', 1000, async () => false).then(woke);
    let inTransaction = false;
    s.tx.run.mockImplementation(async (fn: () => Promise<unknown>) => {
      // Nested domain runs join the settlement transaction.
      if (inTransaction) return fn();
      inTransaction = true;
      try {
        const value = await fn();
        expect(project.publish).not.toHaveBeenCalled();
        expect(threads.publish).not.toHaveBeenCalled();
        expect(woke).not.toHaveBeenCalled();
        if (outcome === 'commit-failure') throw new Error('commit failed');
        return value;
      } finally { inTransaction = false; }
    });
    const original = s.test.command.execute;
    s.test.command.execute = async (value) => {
      await s.tx.run(async () => undefined);
      publisher.publish([{ ...publisher.event({ id: 'job', projectId: 'p1', state: 'RUNNING' }), threadEvents: [
        { id: 'thread-event', type: 'thread', threadId: 't1', at: now.toISOString() },
      ] }]);
      notifier.notify('runner');
      if (outcome === 'rollback') throw new Error('settlement rolled back');
      return original(value);
    };
    project.publish.mockImplementation(() => expect(inTransaction).toBe(false));
    if (outcome === 'commit-failure') await expect(s.service.execute('r1', now)).rejects.toThrow('commit failed');
    else expect(await s.service.execute('r1', now)).toMatchObject({ status: outcome === 'commit' ? 'executed' : 'failed' });
    await Promise.resolve();
    expect(project.publish).toHaveBeenCalledTimes(outcome === 'commit' ? 1 : 0);
    expect(threads.publish).toHaveBeenCalledTimes(outcome === 'commit' ? 1 : 0);
    if (outcome !== 'commit') {
      expect(woke).not.toHaveBeenCalled();
      notifier.notify('runner'); // release the test waiter, not a transaction effect
    }
    await waiting;
  });

  it('stores null when the command has no toResult', async () => {
    const s = setup();
    expect(await s.service.execute('r1', now)).toMatchObject({ status: 'executed', result: null });
  });

  it.each(['pending', 'rejected', 'executed', 'failed'] as const)('refuses a %s request without running', async (status) => {
    const s = setup({ status });
    await expect(s.service.execute('r1', now)).rejects.toEqual(new ApprovalRequestNotPendingError(status));
    expect(s.test.state.calls).toEqual([]);
    expect(s.repo.transition).not.toHaveBeenCalled();
  });

  it('settles no-command when nothing is registered', async () => {
    const s = setup();
    const empty = new ApprovalExecutionService(s.tx as unknown as ITransactionManager,
      s.repo as unknown as PrismaApprovalRequestRepository, s.permissions as unknown as PermissionService, new ApprovalCommandRegistry(), s.events as never);
    expect(await empty.execute('r1', now)).toMatchObject({ status: 'failed', result: { error: 'no-command' }, settledAt: now });
    expect(s.reasons).toEqual(['approval.request-settle', 'approval.request-settle']);
    expect(s.events.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'r1', status: 'failed' }));
  });

  it('settles input-hash-mismatch when the stored input changed', async () => {
    const s = setup({ input: { labelId: 'l2' } });
    expect(await s.service.execute('r1', now)).toMatchObject({ status: 'failed', result: { error: 'input-hash-mismatch' } });
    expect(s.test.state.calls).toEqual([]);
  });

  it('settles permission-revoked without the key, and accepts the .own form', async () => {
    const s = setup();
    s.permissions.effectiveKeys.mockResolvedValue(new Set(['approval.decide']));
    expect(await s.service.execute('r1', now)).toMatchObject({ status: 'failed', result: { error: 'permission-revoked' } });
    expect(s.permissions.effectiveKeys).toHaveBeenCalledWith({ type: 'AGENT', id: 'a1' }, { projectId: 'p1' });
    expect(s.test.state.calls).toEqual([]);

    const own = setup();
    own.permissions.effectiveKeys.mockResolvedValue(new Set(['label.delete.own']));
    expect(await own.service.execute('r1', now)).toMatchObject({ status: 'executed' });
  });

  it('re-checks the on-behalf-of principal at global scope for the assistant', async () => {
    const s = setup({ actor: { type: 'SYSTEM', id: 'assistant' }, onBehalfOf: { type: 'USER', id: 'u9' }, projectId: null });
    expect(await s.service.execute('r1', now)).toMatchObject({ status: 'executed' });
    expect(s.permissions.effectiveKeys).toHaveBeenCalledWith({ type: 'USER', id: 'u9' }, 'global');
  });

  it('settles permission-revoked for an assistant request with no on-behalf-of principal', async () => {
    const s = setup({ actor: { type: 'SYSTEM', id: 'assistant' }, onBehalfOf: null });
    expect(await s.service.execute('r1', now)).toMatchObject({ status: 'failed', result: { error: 'permission-revoked' } });
    expect(s.permissions.effectiveKeys).not.toHaveBeenCalled();
  });

  it('settles invalid-input when the frozen input no longer parses', async () => {
    const s = setup();
    s.test.state.parseThrows = true;
    expect(await s.service.execute('r1', now)).toMatchObject({ status: 'failed', result: { error: 'invalid-input' } });
    expect(s.test.state.calls).toEqual([]);
  });

  it('AC-2: executes a request approved without params with what parseDecision answers for no params', async () => {
    const s = setup();
    s.test.state.parseDecision = { calls: [], result: { remember: false }, throws: false };
    s.repo.findDecisions.mockResolvedValue([approving({ params: null })]);

    expect(await s.service.execute('r1', now)).toMatchObject({ status: 'executed' });

    expect(s.test.state.parseDecision.calls).toEqual([{ decision: 'approve', params: undefined, input }]);
    expect(s.test.state.decisions).toEqual([{ remember: false }]);
  });

  it('AC-2: re-parses with no params when a timeout approval left no decision row', async () => {
    const s = setup();
    s.test.state.parseDecision = { calls: [], result: 'timeout', throws: false };
    s.repo.findDecisions.mockResolvedValue([]);

    expect(await s.service.execute('r1', now)).toMatchObject({ status: 'executed' });
    expect(s.test.state.parseDecision.calls).toEqual([{ decision: 'approve', params: undefined, input }]);
    expect(s.test.state.decisions).toEqual(['timeout']);
  });

  it('AC-3: re-parses the approving decision params before the command runs', async () => {
    const s = setup();
    s.test.state.parseDecision = { calls: [], result: 'ok', throws: false };
    s.repo.findDecisions.mockResolvedValue([approving({ params: { remember: true } })]);

    await s.service.execute('r1', now);

    expect(s.repo.findDecisions).toHaveBeenCalledExactlyOnceWith('r1');
    expect(s.test.state.parseDecision.calls).toEqual([{ decision: 'approve', params: { remember: true }, input }]);
    expect(s.test.state.decisions).toEqual(['ok']);
  });

  it('AC-3: re-parses the last approving decision, ignoring earlier approvals and rejects', async () => {
    const s = setup();
    s.test.state.parseDecision = { calls: [], result: 'ok', throws: false };
    s.repo.findDecisions.mockResolvedValue([
      approving({ id: 'd1', params: { remember: true } }),
      approving({ id: 'd2', decision: 'reject', decidedAt: new Date(now.getTime() + 1), params: { reason: 'no' } }),
      approving({ id: 'd3', decidedAt: new Date(now.getTime() + 2), params: { remember: false } }),
    ]);

    await s.service.execute('r1', now);

    expect(s.test.state.parseDecision.calls).toEqual([{ decision: 'approve', params: { remember: false }, input }]);
  });

  it('AC-4: settles invalid-decision when the stored params no longer parse, without running', async () => {
    const s = setup();
    s.test.state.parseDecision = { calls: [], result: undefined, throws: true };
    s.repo.findDecisions.mockResolvedValue([approving({ params: { remember: true } })]);

    const settled = await s.service.execute('r1', now);

    expect(settled).toMatchObject({ status: 'failed', settledAt: now, result: { error: 'invalid-decision' } });
    expect(s.test.state.calls).toEqual([]);
    expect(s.test.state.decisions).toEqual([]);
    expect(s.repo.transition).toHaveBeenCalledExactlyOnceWith('r1', 'approved', {
      status: 'failed', settledAt: now, result: { error: 'invalid-decision' },
    });
    expect(s.reasons).toEqual(['approval.request-settle', 'approval.request-settle']);
  });

  it('AC-5: executes with an undefined decision without reading decisions when the command takes none', async () => {
    const s = setup();

    expect(await s.service.execute('r1', now)).toMatchObject({ status: 'executed' });

    expect(s.test.state.decisions).toEqual([undefined]);
    expect(s.repo.findDecisions).not.toHaveBeenCalled();
  });

  it('AC-6: runs afterCommit once with the parsed input, the decision and the raw result', async () => {
    const s = setup();
    s.test.state.parseDecision = { calls: [], result: { remember: true }, throws: false };
    s.test.state.afterCommit = { calls: [], throws: null };
    s.test.state.toResult = () => ({ deleted: 1 });
    s.repo.findDecisions.mockResolvedValue([approving({ params: { remember: true } })]);

    const settled = await s.service.execute('r1', now);

    expect(settled).toMatchObject({ status: 'executed', result: { deleted: 1 } });
    expect(s.test.state.afterCommit.calls).toEqual([{ input, decision: { remember: true }, result: 'done' }]);
  });

  it('AC-7: runs afterCommit after the execution transaction resolved', async () => {
    const s = setup();
    s.test.state.afterCommit = { calls: [], throws: null };
    // Records how many afterCommit calls had happened when run() resolved: none, so the hook ran later.
    const atRunResolved: number[] = [];
    s.tx.run.mockImplementation(async (fn: () => Promise<unknown>) => {
      const value = await fn();
      atRunResolved.push(s.test.state.afterCommit?.calls.length ?? -1);
      return value;
    });

    expect(await s.service.execute('r1', now)).toMatchObject({ status: 'executed' });

    expect(atRunResolved).toEqual([0]);
    expect(s.tx.run).toHaveBeenCalledOnce();
    expect(s.test.state.afterCommit.calls).toHaveLength(1);
  });

  it('AC-8: a throwing afterCommit leaves the request executed and only warns', async () => {
    const s = setup();
    s.test.state.afterCommit = { calls: [], throws: new Error('requeue refused') };
    const warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();

    const settled = await s.service.execute('r1', now);

    expect(settled).toMatchObject({ status: 'executed' });
    expect(s.repo.transition).toHaveBeenCalledExactlyOnceWith('r1', 'approved', expect.objectContaining({ status: 'executed' }));
    expect(s.test.state.afterCommit.calls).toHaveLength(1);
    expect(warn.mock.calls[0]?.[0]).toBe('approval request r1 after-commit failed: requeue refused');
  });

  it('AC-9: never runs afterCommit when the command fails and the request settles failed', async () => {
    const s = setup();
    s.test.state.afterCommit = { calls: [], throws: null };
    s.test.state.executeThrows = true;
    const warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();

    const settled = await s.service.execute('r1', now);

    expect(settled).toMatchObject({ status: 'failed', result: { error: 'execution-failed', name: 'Error' } });
    expect(s.test.state.afterCommit.calls).toEqual([]);
    expect(warn.mock.calls[0]?.[0]).toBe('approval request r1 failed to execute: boom');
  });

  it('does not run when the locked re-read is no longer approved', async () => {
    const s = setup();
    s.repo.lockById.mockResolvedValue({ ...s.request, status: 'executed' });
    await expect(s.service.execute('r1', now)).rejects.toEqual(new ApprovalRequestNotPendingError('executed'));
    expect(s.test.state.calls).toEqual([]);
    expect(s.repo.transition).not.toHaveBeenCalled();
  });

  it('rolls back and settles failed in a second transaction when the command throws', async () => {
    const s = setup();
    s.test.state.executeThrows = true;
    const warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();

    const settled = await s.service.execute('r1', now);

    expect(settled).toMatchObject({ status: 'failed', result: { error: 'execution-failed', name: 'Error' } });
    expect(s.tx.run).toHaveBeenCalledTimes(2);
    expect(s.repo.transition).toHaveBeenCalledExactlyOnceWith('r1', 'approved', {
      status: 'failed', settledAt: now, result: { error: 'execution-failed', name: 'Error' },
    });
    expect(s.reasons).toEqual(['approval.request-settle', 'approval.request-settle']);
    expect(s.events.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'r1', status: 'failed' }));
    expect(warn.mock.calls[0]?.[0]).toContain('r1');
  });

  it('does not convert a commit failure after the callback succeeded into execution-failed', async () => {
    const s = setup();
    const commitFailure = new Error('commit failed');
    s.tx.run.mockImplementation(async (fn: () => Promise<unknown>) => { await fn(); throw commitFailure; });

    await expect(s.service.execute('r1', now)).rejects.toBe(commitFailure);
    expect(s.tx.run).toHaveBeenCalledTimes(1);
    expect(s.repo.transition).toHaveBeenCalledTimes(1);
  });

  it('propagates a transaction-start failure without settling the request', async () => {
    const s = setup();
    const startFailure = new Error('cannot open transaction');
    s.tx.run.mockImplementationOnce(async () => { throw startFailure; });

    await expect(s.service.execute('r1', now)).rejects.toBe(startFailure);
    expect(s.test.state.calls).toEqual([]);
    expect(s.repo.transition).not.toHaveBeenCalled();
    expect(s.tx.run).toHaveBeenCalledTimes(1);
  });

  it('keeps a second execute out until a failed first one has settled, so the command runs once', async () => {
    const s = setup();
    // A transaction mock that serialises callbacks like the row lock does, and rolls back nothing else.
    let tail: Promise<unknown> = Promise.resolve();
    s.tx.run.mockImplementation((fn: () => Promise<unknown>) => {
      const next = tail.then(fn, fn);
      tail = next.catch(() => undefined);
      return next;
    });
    s.repo.transition.mockImplementation(async (_id: string, from: string, p: Partial<ApprovalRequestRecord>) => {
      if (s.state.current.status !== from) return null;
      s.state.current = { ...s.state.current, ...p };
      return s.state.current;
    });
    s.test.state.executeThrows = true;

    const results = await Promise.allSettled([s.service.execute('r1', now), s.service.execute('r1', now)]);

    expect(s.test.state.calls).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: { status: 'failed', result: { error: 'execution-failed' } } });
    expect(results[1]).toMatchObject({ status: 'rejected' });
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(ApprovalRequestNotPendingError);
  });
});

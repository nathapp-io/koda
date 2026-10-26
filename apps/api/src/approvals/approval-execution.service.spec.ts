import { Logger } from '@nestjs/common';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import { currentContext, type ActionContext } from '../action-context/action-context';
import { currentBookkeepingReason } from '../action-context/audit-coverage';
import type { PermissionService } from '../permissions/permission.service';
import { ApprovalCommandRegistry } from './approval-command.registry';
import { ApprovalExecutionService } from './approval-execution.service';
import { approvalInputHash } from './approval-input';
import type { ApprovalRequestRecord } from './domain/approval.domain';
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

function setup(patch: Partial<ApprovalRequestRecord> = {}) {
  const request = approved(patch);
  const state = { current: request };
  const reasons: Array<string | undefined> = [];
  const repo = {
    findById: vi.fn().mockImplementation(async () => state.current),
    lockById: vi.fn().mockImplementation(async () => state.current),
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
  const service = new ApprovalExecutionService(tx as unknown as ITransactionManager,
    repo as unknown as PrismaApprovalRequestRepository, permissions as unknown as PermissionService, registry);
  return { request, state, repo, permissions, tx, registry, test, service, reasons };
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
    expect(seen).toEqual({
      actor: { type: 'AGENT', id: 'a1' }, origin: 'mcp', correlationId: 'corr-1',
      approval: { requiredMode: 'agent', satisfiedBy: 'human', approverType: 'USER', approverId: 'u1', requestId: 'r1' },
    });
    expect(s.repo.transition).toHaveBeenCalledExactlyOnceWith('r1', 'approved', { status: 'executed', settledAt: now, result: { deleted: 1 } });
    expect(s.reasons).toEqual(['approval.request-settle']);
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
      s.repo as unknown as PrismaApprovalRequestRepository, s.permissions as unknown as PermissionService, new ApprovalCommandRegistry());
    expect(await empty.execute('r1', now)).toMatchObject({ status: 'failed', result: { error: 'no-command' }, settledAt: now });
    expect(s.reasons).toEqual(['approval.request-settle']);
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
    expect(s.reasons).toEqual(['approval.request-settle']);
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
});

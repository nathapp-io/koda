import { ApprovalDecisionService } from './approval-decision.service';
import { decideEligibility } from './approval-eligibility';
import { currentContext, runWithActionContext } from '../action-context/action-context';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import type { ApprovalExecutionService } from './approval-execution.service';
import type { PrismaApprovalRequestRepository } from './prisma-approval-request.repository';
import type { PermissionService } from '../permissions/permission.service';
import type { AuditRecorder } from '../audit/audit-recorder.service';
import type { ApprovalRequestRecord } from './domain/approval.domain';
import { ApprovalCancelForbiddenError, ApprovalDecideForbiddenError, ApprovalRequestExpiredError, ApprovalRequestNotFoundError, ApprovalRequestNotPendingError } from './domain/approval.errors';

vi.mock('./approval-eligibility', () => ({ decideEligibility: vi.fn() }));
const now = new Date('2026-11-05T09:00:00Z');

function setup() {
  const request: ApprovalRequestRecord = {
    id: 'r1', permissionKey: 'label.delete', projectId: 'p1', actor: { type: 'AGENT', id: 'a1' },
    onBehalfOf: null, origin: 'rest', correlationId: 'c1', input: {}, inputHash: 'hash',
    requiredMode: 'agent', policyId: null, onTimeout: 'reject', approverMustHoldAction: true,
    requireDistinctApprover: false, status: 'pending', satisfiedBy: null, approverType: null, approverId: null,
    expiresAt: new Date(now.getTime() + 1000), decidedAt: null, settledAt: null, result: null, createdAt: now,
  };
  const repo = { lockById: vi.fn().mockResolvedValue(request), createDecision: vi.fn(),
    transition: vi.fn().mockImplementation(async (_id, _from, patch) => ({ ...request, ...patch })) };
  const keys = new Set(['label.delete', 'approval.decide']);
  const permissions = { effectiveKeys: vi.fn().mockResolvedValue(keys) };
  const audit = { record: vi.fn().mockImplementation(async () => { approvals.push(currentContext()?.approval); }) };
  const approvals: unknown[] = [];
  const tx = { run: vi.fn((fn: () => Promise<unknown>) => fn()), getClient: vi.fn(), isInTransaction: vi.fn(() => true) };
  const execution = { execute: vi.fn().mockImplementation(async () => ({ ...request, status: 'executed' })) };
  const events = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new ApprovalDecisionService(tx as ITransactionManager, repo as unknown as PrismaApprovalRequestRepository,
    permissions as unknown as PermissionService, audit as unknown as AuditRecorder, execution as unknown as ApprovalExecutionService, events as never);
  const decide = (decision: 'approve' | 'reject' = 'approve') => runWithActionContext(
    { actor: { type: 'USER', id: 'u1' }, origin: 'rest' }, () => service.decide('r1', decision, decision === 'reject' ? 'no' : null, now));
  return { request, repo, keys, permissions, audit, approvals, tx, execution, events, service, decide };
}

beforeEach(() => { vi.mocked(decideEligibility).mockReset().mockReturnValue({ ok: true, satisfiedBy: 'human' }); });

it('AC-14: delegates the locked request, actor and exact scoped effective keys, mapping refusal', async () => {
  const s = setup();
  vi.mocked(decideEligibility).mockReturnValue({ ok: false, reason: 'tier-too-low' });
  await expect(s.decide()).rejects.toEqual(new ApprovalDecideForbiddenError('tier-too-low'));
  expect(s.permissions.effectiveKeys).toHaveBeenCalledWith({ type: 'USER', id: 'u1' }, { projectId: 'p1' });
  expect(decideEligibility).toHaveBeenCalledExactlyOnceWith(s.request, { type: 'USER', id: 'u1' }, s.keys);
  expect(s.repo.createDecision).not.toHaveBeenCalled();
  expect(s.repo.transition).not.toHaveBeenCalled();
  expect(s.audit.record).not.toHaveBeenCalled();
});

it.each(['SYSTEM', 'RUNNER'] as const)('AC-15: refuses non-principal %s even if eligibility seam is permissive', async (type) => {
  const s = setup();
  await expect(runWithActionContext({ actor: { type, id: 'approval' }, origin: 'system' },
    () => s.service.decide('r1', 'approve', null, now))).rejects.toEqual(new ApprovalDecideForbiddenError('not-a-principal'));
  expect(s.permissions.effectiveKeys).not.toHaveBeenCalled();
  expect(s.repo.createDecision).not.toHaveBeenCalled();
});

it('records rejection and its approval context in the same transaction', async () => {
  const s = setup();
  expect(await s.decide('reject')).toMatchObject({ status: 'rejected', decidedAt: now });
  expect(s.tx.run).toHaveBeenCalledTimes(1);
  expect(s.repo.createDecision).toHaveBeenCalledWith({ requestId: 'r1', deciderType: 'USER', deciderId: 'u1', decision: 'reject', comment: 'no', decidedAt: now });
  expect(s.approvals).toEqual([{ requiredMode: 'agent', satisfiedBy: 'none', requestId: 'r1' }]);
  expect(s.events.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'r1', status: 'rejected' }));
  expect(s.audit.record).toHaveBeenCalledWith({ key: 'approval.decide', resourceType: 'approval-request', resourceId: 'r1', projectId: 'p1', summary: 'rejected label.delete' });
});

it('stores approval attribution and resolves global keys at global scope', async () => {
  const s = setup(); s.request.projectId = null;
  await s.decide();
  expect(s.permissions.effectiveKeys).toHaveBeenCalledWith({ type: 'USER', id: 'u1' }, 'global');
  expect(s.repo.transition).toHaveBeenCalledWith('r1', 'pending', { status: 'approved', decidedAt: now, satisfiedBy: 'human', approverType: 'USER', approverId: 'u1' });
  expect(s.approvals).toEqual([{ requiredMode: 'agent', satisfiedBy: 'human', approverType: 'USER', approverId: 'u1', requestId: 'r1' }]);
  expect(s.events.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'r1', status: 'approved' }));
  expect(s.events.record.mock.invocationCallOrder[0]).toBeLessThan(s.execution.execute.mock.invocationCallOrder[0] as number);
});

it.each(['missing', 'rejected', 'expired', 'boundary'] as const)('refuses %s before any write', async (kind) => {
  const s = setup();
  if (kind === 'missing') s.repo.lockById.mockResolvedValue(null);
  if (kind === 'rejected') s.request.status = 'rejected';
  if (kind === 'expired') s.request.expiresAt = new Date(now.getTime() - 1);
  if (kind === 'boundary') s.request.expiresAt = now;
  const error = kind === 'missing' ? new ApprovalRequestNotFoundError('r1') : kind === 'rejected'
    ? new ApprovalRequestNotPendingError('rejected') : new ApprovalRequestExpiredError('r1');
  await expect(s.decide()).rejects.toEqual(error);
  expect(s.repo.createDecision).not.toHaveBeenCalled();
  expect(s.repo.transition).not.toHaveBeenCalled();
  expect(s.audit.record).not.toHaveBeenCalled();
});

it('executes after an approve commits and returns the execution result', async () => {
  const s = setup();
  expect(await s.decide()).toMatchObject({ status: 'executed' });
  expect(s.execution.execute).toHaveBeenCalledExactlyOnceWith('r1');
  expect(s.tx.run).toHaveBeenCalledTimes(1);
});

it('does not execute a rejection or a refused decision', async () => {
  const s = setup();
  await s.decide('reject');
  vi.mocked(decideEligibility).mockReturnValue({ ok: false, reason: 'tier-too-low' });
  await expect(s.decide()).rejects.toBeInstanceOf(ApprovalDecideForbiddenError);
  expect(s.execution.execute).not.toHaveBeenCalled();
});

describe('cancel', () => {
  const cancel = (s: ReturnType<typeof setup>, actor: NonNullable<ReturnType<typeof currentContext>>['actor'] = { type: 'AGENT', id: 'a1' }) =>
    runWithActionContext({ actor, origin: 'rest' }, () => s.service.cancel('r1', now));

  it('AC-4: records cancellation event and audit inside one transaction, without executing', async () => {
    const s = setup();
    expect(await cancel(s)).toMatchObject({ status: 'cancelled', settledAt: now });
    expect(s.tx.run).toHaveBeenCalledTimes(1);
    expect(s.repo.transition).toHaveBeenCalledExactlyOnceWith('r1', 'pending', { status: 'cancelled', settledAt: now });
    expect(s.events.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'cancelled' }));
    expect(s.audit.record).toHaveBeenCalledExactlyOnceWith({ key: 'approval.request.cancel', resourceType: 'approval-request', resourceId: 'r1', projectId: 'p1', summary: 'cancelled label.delete' });
    expect(s.repo.createDecision).not.toHaveBeenCalled();
    expect(s.execution.execute).not.toHaveBeenCalled();
  });
  it('AC-5: lets the on-behalf-of user withdraw an assistant request', async () => {
    const s = setup(); s.request.actor = { type: 'SYSTEM', id: 'assistant' }; s.request.onBehalfOf = { type: 'USER', id: 'u1' };
    expect(await cancel(s, { type: 'USER', id: 'u1' })).toMatchObject({ status: 'cancelled' });
  });
  it.each([
    { type: 'SYSTEM', id: 'assistant' }, { type: 'RUNNER', id: 'a1' },
    { type: 'USER', id: 'a1' }, { type: 'AGENT', id: 'other' },
  ] as const)('AC-11/12: refuses $type/$id without writes', async actor => {
    const s = setup();
    await expect(cancel(s, actor)).rejects.toEqual(new ApprovalCancelForbiddenError('r1'));
    expect(s.repo.transition).not.toHaveBeenCalled(); expect(s.events.record).not.toHaveBeenCalled(); expect(s.audit.record).not.toHaveBeenCalled();
  });
  it('does not delegate withdrawal for a non-assistant system request', async () => {
    const s = setup(); s.request.actor = { type: 'SYSTEM', id: 'other' }; s.request.onBehalfOf = { type: 'USER', id: 'u1' };
    await expect(cancel(s, { type: 'USER', id: 'u1' })).rejects.toBeInstanceOf(ApprovalCancelForbiddenError);
    expect(s.repo.transition).not.toHaveBeenCalled();
  });
  it('allows an expired but still pending request', async () => {
    const s = setup(); s.request.expiresAt = new Date(now.getTime() - 1);
    expect(await cancel(s)).toMatchObject({ status: 'cancelled' });
  });
  it.each(['missing', 'executed', 'cancelled'] as const)('refuses %s before writes', async kind => {
    const s = setup();
    if (kind === 'missing') s.repo.lockById.mockResolvedValue(null); else s.request.status = kind;
    await expect(cancel(s)).rejects.toEqual(kind === 'missing' ? new ApprovalRequestNotFoundError('r1') : new ApprovalRequestNotPendingError(kind));
    expect(s.repo.transition).not.toHaveBeenCalled(); expect(s.events.record).not.toHaveBeenCalled(); expect(s.audit.record).not.toHaveBeenCalled();
  });
  it('rolls back rather than recording an event after a lost transition', async () => {
    const s = setup(); s.repo.transition.mockResolvedValue(null);
    await expect(cancel(s)).rejects.toBeInstanceOf(ApprovalRequestNotPendingError);
    expect(s.events.record).not.toHaveBeenCalled(); expect(s.audit.record).not.toHaveBeenCalled();
  });
});

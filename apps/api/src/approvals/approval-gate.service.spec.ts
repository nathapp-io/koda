import type { ITransactionManager } from '@nathapp/nestjs-data';
import { ApprovalGate } from './approval-gate.service';
import { ApprovalCommandRegistry } from './approval-command.registry';
import { approvalInputHash } from './approval-input';
import { DEFAULT_APPROVAL_TIMEOUT_SEC, type ApprovalPolicyRecord, type ApprovalRequestRecord } from './domain/approval.domain';
import type { PendingApprovalMatch } from './prisma-approval-request.repository';
import { UnregisteredApprovalCommandError } from './domain/approval.errors';
import type { ResolvedApproval } from './approval-policy.resolver';
import { configurableTestCommand } from './test-helpers/test-approval-command';
import { currentBookkeepingReason } from '../action-context/audit-coverage';
import { currentContext, runWithActionContext, type ActionActor, type ActionApproval } from '../action-context/action-context';

const input = { labelId: 'l1' };
const opts = { projectId: 'p1' };
const now = new Date('2026-11-05T09:00:00Z');

const storedRequest = (patch: Partial<ApprovalRequestRecord> = {}): ApprovalRequestRecord => ({
  id: 'request-1', permissionKey: 'label.delete', projectId: 'p1', actor: { type: 'AGENT', id: 'a1' },
  onBehalfOf: null, origin: 'rest', correlationId: 'correlation', input, inputHash: 'hash',
  requiredMode: 'agent', policyId: null, onTimeout: 'reject', approverMustHoldAction: true,
  requireDistinctApprover: false, status: 'pending', satisfiedBy: null, approverType: null, approverId: null,
  expiresAt: now, decidedAt: null, settledAt: null, result: null, createdAt: now, ...patch,
});

describe('ApprovalGate', () => {
  let registry: ApprovalCommandRegistry;
  let testCommand: ReturnType<typeof configurableTestCommand>;
  let resolve: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<ResolvedApproval>>>;
  let requests: {
    create: ReturnType<typeof vi.fn<(record: ApprovalRequestRecord) => Promise<ApprovalRequestRecord>>>;
    findPendingDuplicate: ReturnType<typeof vi.fn<(match: PendingApprovalMatch, now: Date) => Promise<ApprovalRequestRecord | null>>>;
  };
  let transactions: { run: ReturnType<typeof vi.fn> };
  let gate: ApprovalGate;
  const asActor = <T>(actor: ActionActor, fn: () => T) => runWithActionContext({ actor, origin: 'rest' }, fn);
  const agent = <T>(fn: () => T) => asActor({ type: 'AGENT', id: 'a1' }, fn);

  beforeEach(() => {
    registry = new ApprovalCommandRegistry();
    testCommand = configurableTestCommand('label.delete');
    registry.register(testCommand.command);
    resolve = vi.fn().mockResolvedValue({ mode: 'none', floor: 'none', policy: null, source: 'default' });
    requests = {
      create: vi.fn(async (record: ApprovalRequestRecord) => record),
      findPendingDuplicate: vi.fn().mockResolvedValue(null),
    };
    transactions = { run: vi.fn(<T>(fn: () => Promise<T>) => fn()) };
    gate = new ApprovalGate(registry, { resolve }, requests, transactions as unknown as ITransactionManager);
  });
  const untouched = () => {
    expect(resolve).not.toHaveBeenCalled();
    expect(testCommand.state.calls).toEqual([]);
    expect(requests.findPendingDuplicate).not.toHaveBeenCalled();
    expect(requests.create).not.toHaveBeenCalled();
  };
  it('AC-1: refuses an unregistered key before checking context', async () => {
    gate = new ApprovalGate(new ApprovalCommandRegistry(), { resolve }, requests, transactions as unknown as ITransactionManager);
    await expect(gate.gate('label.delete', input, opts)).rejects.toEqual(new UnregisteredApprovalCommandError('label.delete'));
    untouched();
  });
  it('AC-2: requires an action context before parsing', async () => {
    testCommand.state.parseThrows = true;
    await expect(gate.gate('label.delete', input, opts)).rejects.toThrow('approval gate needs an action context');
    untouched();
  });
  it.each([
    ['AC-3', { type: 'RUNNER', id: 'r1' }],
    ['AC-11', { type: 'SYSTEM', id: 'assistant' }],
    ['AC-13', { type: 'SYSTEM', id: 'approval' }],
  ] as const)('%s: refuses unsupported actors before parsing', async (_ac, actor) => {
    testCommand.state.parseThrows = true;
    await expect(asActor(actor, () => gate.gate('label.delete', input, opts))).rejects.toThrow(`approval gate cannot gate actor ${actor.type}/${actor.id}`);
    untouched();
  });
  it.each([
    [{ type: 'USER', id: 'u1' }, { type: 'USER', id: 'u1' }],
    [{ type: 'AGENT', id: 'a1' }, { type: 'AGENT', id: 'a1' }],
  ] as const)('derives the resolver subject from %j', async (actor, subject) => {
    await asActor(actor, () => gate.gate('label.delete', input, opts));
    expect(resolve).toHaveBeenCalledExactlyOnceWith({ key: 'label.delete', projectId: 'p1', subject });
    expect(requests.create).not.toHaveBeenCalled();
  });
  it('AC-4: resolves the assistant rather than its on-behalf-of principal', async () => {
    await runWithActionContext({ actor: { type: 'SYSTEM', id: 'assistant' }, onBehalfOf: { type: 'USER', id: 'u9' }, origin: 'thread' }, () => gate.gate('label.delete', input, opts));
    expect(resolve).toHaveBeenCalledExactlyOnceWith({ key: 'label.delete', projectId: 'p1', subject: { type: 'ASSISTANT', id: 'assistant' } });
  });
  it('AC-8: requires project scope before resolution', async () => {
    await expect(agent(() => gate.gate('label.delete', input, { projectId: null }))).rejects.toThrow('approval gate needs a project for key label.delete');
    untouched();
  });
  it.each([['AC-10', undefined], ['AC-12', null]] as const)('%s: refuses absent parsed input before scope checking', async (_ac, value) => {
    vi.spyOn(testCommand.command, 'parse').mockReturnValue(value as unknown as Record<string, string>);
    await expect(agent(() => gate.gate('label.delete', input, { projectId: null }))).rejects.toThrow('approval command parse returned no input: label.delete');
    untouched();
  });
  it('propagates parse errors without resolving or executing', async () => {
    const error = new TypeError('bad input');
    vi.spyOn(testCommand.command, 'parse').mockImplementation(() => { throw error; });
    await expect(agent(() => gate.gate('label.delete', input, opts))).rejects.toBe(error);
    untouched();
  });
  it.each([
    ['AC-5', 'USER', 'agent', { requiredMode: 'agent', satisfiedBy: 'human', approverType: 'USER', approverId: 'u1' }],
    ['AC-6', 'AGENT', 'none', { requiredMode: 'none', satisfiedBy: 'none' }],
    ['AC-7', 'USER', 'none', { requiredMode: 'none', satisfiedBy: 'none' }],
    ['AC-9', 'USER', 'human', { requiredMode: 'human', satisfiedBy: 'human', approverType: 'USER', approverId: 'u1' }],
  ] as const)('%s: runs now with scoped approval and restores the outer context', async (_ac, type, mode, approval) => {
    resolve.mockResolvedValue({ mode, floor: 'none', policy: null, source: 'default' });
    let executionApproval: ActionApproval | undefined;
    const execute = testCommand.command.execute;
    vi.spyOn(testCommand.command, 'execute').mockImplementation(async (parsed) => {
      await Promise.resolve();
      executionApproval = currentContext()?.approval;
      expect(currentContext()).toMatchObject({ actor: { type, id: type === 'USER' ? 'u1' : 'a1' }, origin: 'rest', correlationId: 'correlation' });
      return execute(parsed);
    });
    await runWithActionContext({ actor: { type, id: type === 'USER' ? 'u1' : 'a1' }, origin: 'rest', correlationId: 'correlation' }, async () => {
      const outer = currentContext();
      expect(await gate.gate('label.delete', input, opts)).toEqual({ status: 'executed', result: 'done', approval });
      expect(currentContext()).toBe(outer);
    });
    expect(executionApproval).toEqual(approval);
    expect(testCommand.state.calls).toEqual([input]);
    expect(requests.findPendingDuplicate).not.toHaveBeenCalled();
    expect(requests.create).not.toHaveBeenCalled();
  });

  it('opens a pending request with the frozen input, hash and default snapshot', async () => {
    resolve.mockResolvedValue({ mode: 'agent', floor: 'none', policy: null, source: 'default' });
    requests.create.mockImplementation(async (record: ApprovalRequestRecord) => {
      expect(currentBookkeepingReason()).toBe('approval.request-open');
      return record;
    });

    const outcome = await runWithActionContext(
      { actor: { type: 'AGENT', id: 'a1' }, origin: 'rest', correlationId: 'correlation' },
      () => gate.gate('label.delete', input, opts, now),
    );

    expect(outcome).toMatchObject({ status: 'pending', request: { id: expect.any(String) } });
    expect(requests.findPendingDuplicate).toHaveBeenCalledExactlyOnceWith({
      actorType: 'AGENT', actorId: 'a1', onBehalfOfType: null, onBehalfOfId: null,
      permissionKey: 'label.delete', projectId: 'p1', inputHash: approvalInputHash(input),
    }, now);
    expect(transactions.run).toHaveBeenCalledTimes(1);
    expect(requests.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      permissionKey: 'label.delete', projectId: 'p1', actor: { type: 'AGENT', id: 'a1' }, onBehalfOf: null,
      origin: 'rest', correlationId: 'correlation', input: { labelId: 'l1' },
      inputHash: approvalInputHash(input), status: 'pending', requiredMode: 'agent', policyId: null,
      satisfiedBy: null, approverType: null, approverId: null, onTimeout: 'reject',
      approverMustHoldAction: true, requireDistinctApprover: false,
      expiresAt: new Date(now.getTime() + DEFAULT_APPROVAL_TIMEOUT_SEC * 1000),
    }));
    expect(testCommand.state.calls).toEqual([]);
  });

  it('returns the still-pending duplicate instead of opening a second request', async () => {
    resolve.mockResolvedValue({ mode: 'agent', floor: 'none', policy: null, source: 'default' });
    const existing = storedRequest();
    requests.findPendingDuplicate.mockResolvedValue(existing);

    await expect(agent(() => gate.gate('label.delete', input, opts, now)))
      .resolves.toEqual({ status: 'pending', request: existing });
    expect(requests.create).not.toHaveBeenCalled();
    expect(testCommand.state.calls).toEqual([]);
  });

  it('snapshots the resolved policy settings and timeout onto the request', async () => {
    const policy: ApprovalPolicyRecord = {
      id: 'policy-1', selector: 'p1|label.delete|all', projectId: 'p1', permissionPattern: 'label.delete',
      principalType: null, roleId: null, principalId: null, mode: 'self', timeoutSec: 600,
      onTimeout: 'approve', requiredApprovals: 1, approverMustHoldAction: false, requireDistinctApprover: true,
      updatedByType: 'USER', updatedById: 'u1', createdAt: now, updatedAt: now,
    };
    resolve.mockResolvedValue({ mode: 'self', floor: 'none', policy, source: 'policy' });

    await agent(() => gate.gate('label.delete', input, opts, now));

    expect(requests.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      requiredMode: 'self', policyId: 'policy-1', onTimeout: 'approve',
      approverMustHoldAction: false, requireDistinctApprover: true,
      expiresAt: new Date(now.getTime() + 600_000),
    }));
  });

  it('defaults the clock to the current time when the caller passes none', async () => {
    resolve.mockResolvedValue({ mode: 'agent', floor: 'none', policy: null, source: 'default' });
    const before = Date.now();

    await agent(() => gate.gate('label.delete', input, opts));

    const created = requests.create.mock.calls[0]?.[0];
    expect(created?.expiresAt.getTime()).toBeGreaterThanOrEqual(before + DEFAULT_APPROVAL_TIMEOUT_SEC * 1000);
    expect(requests.findPendingDuplicate).toHaveBeenCalledWith(expect.anything(), expect.any(Date));
    expect(testCommand.state.calls).toEqual([]);
  });

  it('keys the duplicate lookup on the on-behalf-of principal of an assistant call', async () => {
    resolve.mockResolvedValue({ mode: 'human', floor: 'none', policy: null, source: 'default' });

    await runWithActionContext(
      { actor: { type: 'SYSTEM', id: 'assistant' }, onBehalfOf: { type: 'USER', id: 'u8' }, origin: 'thread' },
      () => gate.gate('label.delete', input, opts, now),
    );

    expect(requests.findPendingDuplicate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      actorType: 'SYSTEM', actorId: 'assistant', onBehalfOfType: 'USER', onBehalfOfId: 'u8',
    }), now);
    expect(requests.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      actor: { type: 'SYSTEM', id: 'assistant' }, onBehalfOf: { type: 'USER', id: 'u8' },
      origin: 'thread', requiredMode: 'human',
    }));
  });
});

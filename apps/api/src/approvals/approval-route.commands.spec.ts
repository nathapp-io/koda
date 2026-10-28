import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalPolicyNotFoundError, ApprovalRequestExpiredError, ApprovalRequestNotPendingError } from './domain/approval.errors';
import type { ApprovalRequestRecord } from './domain/approval.domain';
import type { ApprovalCommand } from './approval-command.registry';
import { rethrowApprovalError } from './approval-http-errors';
import { ApprovalCommandRegistry } from './approval-command.registry';
import { ApprovalRouteCommands, APPROVAL_ROUTE_VARIANTS } from './approval-route.commands';

describe('ApprovalRouteCommands decisions', () => {
  type Input = { requestId: string; decision: 'approve' | 'reject'; comment: string | null; params?: unknown };
  let command: ApprovalCommand<Input, ApprovalRequestRecord>;
  const decisions = { recordDecision: vi.fn() };
  const execution = { execute: vi.fn() };
  beforeEach(() => {
    vi.resetAllMocks();
    const registry = new ApprovalCommandRegistry();
    new ApprovalRouteCommands(registry, {} as never, decisions as never, execution as never, {} as never,
      { forContext: vi.fn().mockResolvedValue({ actorType: 'agent', id: 'a1' }) } as never).onModuleInit();
    const registered = registry.get('approval.decide', 'rest:approvals.decide');
    expect(registered).toBeDefined();
    command = registered as ApprovalCommand<Input, ApprovalRequestRecord>;
  });

  it('AC-11: refuses an invalid decision with approvals.invalidInput', () => {
    expect(() => command.parse({ requestId: 'r1', decision: 'maybe', comment: null })).toThrow(ValidationAppException);
    try { command.parse({ requestId: 'r1', decision: 'maybe', comment: null }); }
    catch (error) { expect(error).toMatchObject({ prefix: 'approvals.invalidInput' }); }
  });
  it.each([
    null, [], { requestId: '', decision: 'approve', comment: null },
    { requestId: 'r1', decision: 'approve', comment: 42 },
  ].map((input) => [input]))('refuses invalid envelopes: %j', (input) => {
    expect(() => command.parse(input)).toThrow(ValidationAppException);
  });
  it.each([null, false, 42, 'choice', ['a'], { a: 1 }].map((params) => [params]))('preserves JSON params: %j', (params) => {
    expect(command.parse({ requestId: 'r1', decision: 'approve', comment: null, params }).params).toEqual(params);
  });
  it('AC-12: records a reject without executing the inner request', async () => {
    const record = { id: 'r1', status: 'rejected' };
    decisions.recordDecision.mockResolvedValue(record);
    const input = command.parse({ requestId: 'r1', decision: 'reject', comment: 'no' });
    expect(await command.execute(input)).toBe(record);
    expect(decisions.recordDecision).toHaveBeenCalledExactlyOnceWith('r1', 'reject', 'no', expect.any(Date), undefined);
    expect(execution.execute).not.toHaveBeenCalled();
  });
  it('AC-13: afterCommit uses the frozen approve, not the engine decision params', async () => {
    expect(command.afterCommit).toBeTypeOf('function');
    await command.afterCommit?.({ requestId: 'r1', decision: 'approve', comment: null }, { decision: 'reject' }, undefined);
    expect(execution.execute).toHaveBeenCalledExactlyOnceWith('r1');
  });
  it('afterCommit never executes a reject, even if the outer request was approved', async () => {
    expect(command.afterCommit).toBeTypeOf('function');
    await command.afterCommit?.({ requestId: 'r1', decision: 'reject', comment: null }, 'approve', undefined);
    expect(execution.execute).not.toHaveBeenCalled();
  });
  it.each([
    [new ApprovalRequestNotPendingError('cancelled'), 'not-pending', 'cancelled', 'approvals.notPending'],
    [new ApprovalRequestExpiredError('r1'), 'expired', undefined, 'approvals.expired'],
  ])('wraps %s for deferred failure and maps it back for immediate HTTP', async (cause, reason, status, prefix) => {
    decisions.recordDecision.mockRejectedValue(cause);
    const input = command.parse({ requestId: 'r1', decision: 'approve', comment: null });
    const error = await command.execute(input).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'DeferredDecisionRefusedError', reason, status });
    expect(() => rethrowApprovalError(error)).toThrow(expect.objectContaining({ prefix, status: 409 }));
  });
  it('leaves other domain errors unchanged', async () => {
    const error = new Error('database unavailable');
    decisions.recordDecision.mockRejectedValue(error);
    await expect(command.execute({ requestId: 'r1', decision: 'approve', comment: null })).rejects.toBe(error);
  });
  it('projects the decided record to a summary without inner input, result or decisions', () => {
    const now = new Date();
    const record = { id: 'r1', actor: { type: 'AGENT', id: 'b1' }, onBehalfOf: null, createdAt: now,
      expiresAt: now, decidedAt: now, settledAt: null, status: 'approved', input: { secret: true }, result: { secret: true } } as ApprovalRequestRecord;
    expect(command.toResult).toBeTypeOf('function');
    const result = command.toResult?.(record);
    expect(result).toMatchObject({ id: 'r1', status: 'approved' });
    for (const key of ['input', 'result', 'decisions']) expect(result).not.toHaveProperty(key);
  });
});

describe('ApprovalRouteCommands global policies', () => {
  const policies = {
    create: vi.fn(), update: vi.fn(), remove: vi.fn(), get: vi.fn(),
  };
  let registry: ApprovalCommandRegistry;
  const principalLoader = { forContext: vi.fn(async () => ({ actorType: 'agent' as const, id: 'a1', name: 'agent', slug: 'agent', status: 'ACTIVE' as const, capabilities: [], blacklisted: false, revoked: false, authorities: [], extra: {} })) };
  let commands: ApprovalRouteCommands;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new ApprovalCommandRegistry();
    commands = new ApprovalRouteCommands(registry, policies as never, {} as never, {} as never, {} as never, principalLoader as never);
    commands.onModuleInit();
  });

  it('AC-9 registers the three global policy command variants', () => {
    expect(registry.get('approval.policy.manage', 'rest:approval-policies.create')).toBeDefined();
    expect(registry.get('approval.policy.manage', 'rest:approval-policies.update')).toBeDefined();
    expect(registry.get('approval.policy.manage', 'rest:approval-policies.delete')).toBeDefined();
  });

  it('AC-10 rejects an empty update patch', () => {
    const command = registry.get('approval.policy.manage', APPROVAL_ROUTE_VARIANTS.policyUpdate);
    let error: unknown;
    try { command?.parse({ id: 'p1', patch: {} }); } catch (thrown) { error = thrown; }
    expect(error).toBeInstanceOf(ValidationAppException);
    expect((error as ValidationAppException).prefix).toBe('approvals.emptyPolicyPatch');
  });

  it('AC-10 registers the three project policy command variants', () => {
    expect(registry.get('approval.policy.manage', 'rest:project-approval-policies.create')).toBeDefined();
    expect(registry.get('approval.policy.manage', 'rest:project-approval-policies.update')).toBeDefined();
    expect(registry.get('approval.policy.manage', 'rest:project-approval-policies.delete')).toBeDefined();
  });

  it('AC-8 rechecks project ownership when executing a deferred update', async () => {
    policies.get.mockResolvedValue({ id: 'policy1', projectId: 'another-project' });
    const command = registry.get('approval.policy.manage', APPROVAL_ROUTE_VARIANTS.projectPolicyUpdate);
    const input = command?.parse({ projectId: 'project1', id: 'policy1', patch: { mode: 'human' } });
    await expect(command?.execute(input)).rejects.toBeInstanceOf(ApprovalPolicyNotFoundError);
    expect(policies.update).not.toHaveBeenCalled();
  });

  it('AC-9 creates a project policy using the frozen project id', async () => {
    const command = registry.get('approval.policy.manage', APPROVAL_ROUTE_VARIANTS.projectPolicyCreate);
    const input = command?.parse({ projectId: 'project1', policy: {
      permissionPattern: 'label.delete', appliesTo: { kind: 'type', principalType: 'USER' }, mode: 'agent',
    } });
    await command?.execute(input);
    expect(policies.create).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project1' }));
  });

  it('AC-11 refuses deleting project policy and does not remove it', async () => {
    policies.get.mockResolvedValue({ id: 'p1', projectId: 'p1' });
    const command = registry.get('approval.policy.manage', APPROVAL_ROUTE_VARIANTS.policyDelete);
    const input = command?.parse({ id: 'policy1' });
    await expect(command?.execute(input)).rejects.toBeInstanceOf(ApprovalPolicyNotFoundError);
    expect(policies.remove).not.toHaveBeenCalled();
  });
});

import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalPolicyNotFoundError } from './domain/approval.errors';
import { ApprovalCommandRegistry } from './approval-command.registry';
import { ApprovalRouteCommands, APPROVAL_ROUTE_VARIANTS } from './approval-route.commands';

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

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
    expect(registry.get('approval.policy.manage', APPROVAL_ROUTE_VARIANTS.policyCreate)).toBeDefined();
    expect(registry.get('approval.policy.manage', APPROVAL_ROUTE_VARIANTS.policyUpdate)).toBeDefined();
    expect(registry.get('approval.policy.manage', APPROVAL_ROUTE_VARIANTS.policyDelete)).toBeDefined();
  });

  it('AC-10 rejects an empty update patch', () => {
    const command = registry.get('approval.policy.manage', APPROVAL_ROUTE_VARIANTS.policyUpdate);
    let error: unknown;
    try { command?.parse({ id: 'p1', patch: {} }); } catch (thrown) { error = thrown; }
    expect(error).toBeInstanceOf(ValidationAppException);
    expect((error as ValidationAppException).prefix).toBe('approvals.emptyPolicyPatch');
  });

  it('AC-11 refuses deleting project policy and does not remove it', async () => {
    policies.get.mockResolvedValue({ id: 'p1', projectId: 'p1' });
    const command = registry.get('approval.policy.manage', APPROVAL_ROUTE_VARIANTS.policyDelete);
    const input = command?.parse({ id: 'policy1' });
    await expect(command?.execute(input)).rejects.toBeInstanceOf(ApprovalPolicyNotFoundError);
    expect(policies.remove).not.toHaveBeenCalled();
  });
});

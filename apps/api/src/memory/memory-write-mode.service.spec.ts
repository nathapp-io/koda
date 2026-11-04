import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import type { ApprovalPolicyResolver } from '../approvals/approval-policy.resolver';
import type { ApprovalPolicyService } from '../approvals/approval-policy.service';
import { MemoryWriteModeService } from './memory-write-mode.service';

const agent = { actorType: 'agent', id: 'agent-a' } as KodaPrincipal;
const user = { actorType: 'user', id: 'user-a' } as KodaPrincipal;
const resolved = (mode: 'none' | 'human', policyId: string | null, source: 'policy' | 'default') => ({
  mode, floor: 'none' as const, policy: policyId ? { id: policyId } as never : null, source,
});
const policy = (values: Record<string, unknown> = {}) => ({
  id: 'policy-a', selector: 'selector', projectId: 'p1', permissionPattern: 'memory.create',
  principalType: 'AGENT', roleId: null, principalId: null, mode: 'none', timeoutSec: null,
  onTimeout: 'reject', requiredApprovals: 1, approverMustHoldAction: true, requireDistinctApprover: false,
  updatedByType: 'USER', updatedById: 'user-a', createdAt: new Date(), updatedAt: new Date(), ...values,
});

describe('MemoryWriteModeService', () => {
  const resolver = { resolve: vi.fn() };
  const policies = { list: vi.fn(), getProjectAgentMemoryCreatePolicy: vi.fn() };
  let service: MemoryWriteModeService;

  beforeEach(() => {
    vi.resetAllMocks();
    resolver.resolve.mockResolvedValue(resolved('none', null, 'default'));
    policies.list.mockResolvedValue([]);
    policies.getProjectAgentMemoryCreatePolicy.mockResolvedValue(null);
    service = new MemoryWriteModeService(resolver as unknown as ApprovalPolicyResolver, policies as unknown as ApprovalPolicyService);
  });

  it('AC-1 resolves the caller subject with the approval subject owner type', async () => {
    await service.resolve('p1', agent);
    expect(resolver.resolve).toHaveBeenCalledWith({ key: 'memory.create', projectId: 'p1', subject: { type: 'AGENT', id: 'agent-a' } });
  });

  it('AC-2 maps an agent approval policy to proposal and carries resolver metadata', async () => {
    resolver.resolve.mockResolvedValue(resolved('human', 'pol1', 'policy'));
    expect(await service.resolve('p1', agent)).toMatchObject({ mode: 'proposal', policyId: 'pol1', source: 'policy' });
  });

  it('AC-3 maps default none to direct', async () => {
    expect(await service.resolve('p1', agent)).toMatchObject({ mode: 'direct', policyId: null, source: 'default' });
  });

  it('AC-4 keeps user writes direct even when the resolver requires approval', async () => {
    resolver.resolve.mockResolvedValue(resolved('human', 'pol1', 'policy'));
    expect(await service.resolve('p1', user)).toMatchObject({ mode: 'direct' });
  });

  it('AC-5 selects the exact project-wide AGENT type policy, even when disabled', async () => {
    policies.getProjectAgentMemoryCreatePolicy.mockResolvedValue(policy());
    expect(await service.resolve('p1', agent)).toMatchObject({ agentPolicy: { id: 'policy-a', mode: 'none' } });
    expect(policies.getProjectAgentMemoryCreatePolicy).toHaveBeenCalledWith('p1');
  });

  it('AC-6 does not expose a role- or principal-specific policy as agentPolicy', async () => {
    policies.getProjectAgentMemoryCreatePolicy.mockResolvedValue(null);
    expect(await service.resolve('p1', agent)).toMatchObject({ agentPolicy: null });
    expect(policies.getProjectAgentMemoryCreatePolicy).toHaveBeenCalledWith('p1');
  });
});

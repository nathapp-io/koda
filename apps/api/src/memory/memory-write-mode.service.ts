import { Injectable } from '@nestjs/common';
import type { ApprovalMode } from '../permissions/catalog';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { ApprovalPolicyResolver } from '../approvals/approval-policy.resolver';
import { ApprovalPolicyService } from '../approvals/approval-policy.service';
import { ownerTypeFor } from './memory-write.guard';

export interface MemoryWriteMode {
  mode: 'direct' | 'proposal';
  policyId: string | null;
  source: 'policy' | 'default' | 'not-approvable';
  agentPolicy: { id: string; mode: ApprovalMode } | null;
}

@Injectable()
export class MemoryWriteModeService {
  constructor(
    private readonly resolver: ApprovalPolicyResolver,
    private readonly policies: ApprovalPolicyService,
  ) {}

  async resolve(projectId: string, principal: KodaPrincipal): Promise<MemoryWriteMode> {
    const [approval, agentPolicy] = await Promise.all([
      this.resolver.resolve({
        key: 'memory.create',
        projectId,
        subject: { type: ownerTypeFor(principal), id: principal.id },
      }),
      this.policies.getProjectAgentMemoryCreatePolicy(projectId),
    ]);
    const mode = principal.actorType === 'agent' && approval.mode !== 'none' ? 'proposal' : 'direct';
    return {
      mode,
      policyId: approval.policy?.id ?? null,
      source: approval.source,
      agentPolicy: agentPolicy ? { id: agentPolicy.id, mode: agentPolicy.mode } : null,
    };
  }
}
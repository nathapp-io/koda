import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type { GetProjectContextResponse } from '../context/context-builder.service';

export type AgentCapability = 'ticket_ops' | 'code_search' | 'code_write' | 'planning' | 'incident_diagnosis';

export interface AgentAdapter {
  agentId: string;
  name: string;
  capabilities: AgentCapability[];
  formatContext(ctx: GetProjectContextResponse): string;
}

export interface AgentInfo {
  agentId: string;
  name: string;
  capabilities: AgentCapability[];
}

@Injectable()
export class AgentRegistryService {
  private readonly adapters = new Map<string, AgentAdapter>();
  private readonly knownAgentIds = new Set<string>(['claude-code', 'nax']);

  register(agentId: string, adapter: AgentAdapter): void {
    if (!this.knownAgentIds.has(adapter.agentId)) {
      throw new InternalServerErrorException(
        `Unknown agent type: ${adapter.agentId}`,
      );
    }

    if (this.knownAgentIds.has(agentId) && agentId !== adapter.agentId) {
      throw new InternalServerErrorException(
        `Agent ID mismatch: ${agentId} vs ${adapter.agentId}`,
      );
    }

    this.adapters.set(adapter.agentId, adapter);
  }

  getAdapter(agentId: string): AgentAdapter {
    const adapter = this.adapters.get(agentId);
    if (!adapter) {
      throw new InternalServerErrorException(`Agent adapter not found: ${agentId}`);
    }
    return adapter;
  }

  listAgents(): AgentInfo[] {
    return Array.from(this.adapters.values()).map((a) => ({
      agentId: a.agentId,
      name: a.name,
      capabilities: a.capabilities,
    }));
  }
}

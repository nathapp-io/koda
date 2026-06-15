export const AGENT_REPOSITORY = Symbol('AGENT_REPOSITORY');

export interface AgentRoleDomain {
  id: string;
  agentId: string;
  role: string;
}

export interface AgentCapabilityDomain {
  id: string;
  agentId: string;
  capability: string;
}

export interface AgentDomain {
  id: string;
  name: string;
  slug: string;
  apiKeyHash: string;
  status: string;
  maxConcurrentTickets: number | null;
  createdAt: Date;
  updatedAt: Date;
  roles?: AgentRoleDomain[];
  capabilities?: AgentCapabilityDomain[];
}

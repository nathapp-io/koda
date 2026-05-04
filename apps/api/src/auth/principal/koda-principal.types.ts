import type { IPrincipal } from '@nathapp/nestjs-auth';

export type KodaUserRole = 'MEMBER' | 'ADMIN';
export type KodaAgentStatus = 'ACTIVE' | 'PAUSED' | 'OFFLINE';
export type KodaAgentRole = string;

export interface UserPrincipal extends IPrincipal {
  actorType: 'user';
  id: string;
  role: KodaUserRole;
  email: string;
}

export interface AgentPrincipal extends IPrincipal {
  actorType: 'agent';
  id: string;
  slug: string;
  status: KodaAgentStatus;
  agentRoles: KodaAgentRole[];
  capabilities: string[];
}

export type KodaPrincipal = UserPrincipal | AgentPrincipal;

export const isUserPrincipal = (principal: KodaPrincipal): principal is UserPrincipal =>
  principal.actorType === 'user';

export const isAgentPrincipal = (principal: KodaPrincipal): principal is AgentPrincipal =>
  principal.actorType === 'agent';

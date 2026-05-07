import type { IPrincipal } from '@nathapp/nestjs-auth';
import type { AgentRoleNames } from '../../common/enums';

export type KodaUserRole = 'MEMBER' | 'ADMIN';
export type KodaAgentStatus = 'ACTIVE' | 'PAUSED' | 'OFFLINE';
export type KodaAgentRole = AgentRoleNames;

export interface UserPrincipal extends IPrincipal {
  actorType: 'user';
  id: string;
  readonly sub?: string;
  role: KodaUserRole;
  email: string;
  projectRole?: string;
}

export interface AgentPrincipal extends IPrincipal {
  actorType: 'agent';
  id: string;
  readonly sub?: string;
  slug: string;
  status: KodaAgentStatus;
  agentRoles: readonly KodaAgentRole[];
  capabilities: readonly string[];
}

export type KodaPrincipal = UserPrincipal | AgentPrincipal;

export const isUserPrincipal = (principal: KodaPrincipal): principal is UserPrincipal =>
  principal.actorType === 'user';

export const isAgentPrincipal = (principal: KodaPrincipal): principal is AgentPrincipal =>
  principal.actorType === 'agent';

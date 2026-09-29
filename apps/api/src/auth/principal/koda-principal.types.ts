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

export interface RunnerPrincipal extends IPrincipal {
  actorType: 'runner';
  id: string;
  readonly sub?: string;
  runnerName: string;
  labels: readonly string[];
  /** Disabled runners still authenticate so they can drain; placement ignores them. */
  enabled: boolean;
}

export type KodaPrincipal = UserPrincipal | AgentPrincipal | RunnerPrincipal;

export const isUserPrincipal = (principal: KodaPrincipal): principal is UserPrincipal =>
  principal.actorType === 'user';

export const isAgentPrincipal = (principal: KodaPrincipal): principal is AgentPrincipal =>
  principal.actorType === 'agent';

export const isRunnerPrincipal = (principal: KodaPrincipal): principal is RunnerPrincipal =>
  principal.actorType === 'runner';

/** Binary actor kind for ticket/comment events. Runners never author domain records. */
export function actorKind(principal: KodaPrincipal): 'user' | 'agent' {
  if (principal.actorType === 'runner') throw new Error('runner principals cannot author domain records');
  return principal.actorType;
}

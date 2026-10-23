import { ActorRole } from '../../../common/enums';

/** Roles a user can hold through the membership API (AGENT/MEMBER are not assignable). */
export const PROJECT_MEMBER_ROLES = [ActorRole.ADMIN, ActorRole.DEVELOPER, ActorRole.VIEWER] as const;
export type ProjectMemberRole = (typeof PROJECT_MEMBER_ROLES)[number];

/** The two kinds of principal a project member row can be. */
export type MemberPrincipalType = 'USER' | 'AGENT';

/**
 * One role chip of a member row: a `RoleBinding` of that principal in the project.
 *
 * Every chip is a binding row now (Permissions P1l US-006): the legacy rows that stood for a role
 * without a binding to edit are gone, so `id` is always the `RoleBinding.id` a client edits.
 */
export interface MemberBinding {
  /** The `RoleBinding` row this chip is. */
  id: string;
  roleKey: string;
  roleName: string;
}

export interface ProjectMemberRecord {
  /** Null for an agent: an agent principal has no user account. */
  userId: string | null;
  /** Null for an agent, for the same reason. */
  email: string | null;
  name: string | null;
  /** Global account state; a disabled member cannot act and is not an active admin. Agents are never disabled. */
  disabled: boolean;
  joinedAt: Date;
  principalType: MemberPrincipalType;
  /** The `User.id` or `Agent.id` the row names (`=== userId` for a user). */
  principalId: string;
  /** Null for a user: only an agent principal has a slug. */
  agentSlug: string | null;
  /** The principal's role bindings in this project, oldest first. */
  bindings: MemberBinding[];
}

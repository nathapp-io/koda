import { ActorRole } from '../../../common/enums';

/** Roles a user can hold through the membership API (AGENT/MEMBER are not assignable). */
export const PROJECT_MEMBER_ROLES = [ActorRole.ADMIN, ActorRole.DEVELOPER, ActorRole.VIEWER] as const;
export type ProjectMemberRole = (typeof PROJECT_MEMBER_ROLES)[number];

/** The two kinds of principal a project member row can be. */
export type MemberPrincipalType = 'USER' | 'AGENT';

/**
 * One role chip of a member row: a `RoleBinding` of that principal in the project, or — with a null
 * `id` — the virtual binding its legacy row (`ProjectMember`, `AgentProject`) still stands for.
 */
export interface MemberBinding {
  /** The binding row; null for the entry that stands for a legacy row. */
  id: string | null;
  roleKey: string;
  roleName: string;
}

export interface ProjectMemberRecord {
  /** Null for an agent: an agent principal has no user account. */
  userId: string | null;
  /** Null for an agent, for the same reason. */
  email: string | null;
  name: string | null;
  role: string;
  /** Global account state; a disabled member cannot act and is not an active admin. Agents are never disabled. */
  disabled: boolean;
  joinedAt: Date;
  principalType: MemberPrincipalType;
  /** The `User.id` or `Agent.id` the row names (`=== userId` for a user). */
  principalId: string;
  /** Null for a user: only an agent principal has a slug. */
  agentSlug: string | null;
  /** The principal's role bindings in this project, oldest first, then its legacy row's entry. */
  bindings: MemberBinding[];
}

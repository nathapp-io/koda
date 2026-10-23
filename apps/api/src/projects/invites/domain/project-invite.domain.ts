import { PROJECT_MEMBER_ROLES, ProjectMemberRole } from '../../members/domain/project-member.domain';

/** Fleet S4b US-004: invite lifecycle states (mirror the package `IInvitation` values). */
export type InviteStatus = 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'CANCELLED';

/** Roles an invite may grant. AGENT and MEMBER are not offered (spec §4.1). */
export const INVITE_ROLES: readonly ProjectMemberRole[] = PROJECT_MEMBER_ROLES;

export interface ProjectInviteRecord {
  id: string;
  projectId: string;
  email: string;
  /** The role the invite binds; null for a pre-migration invite or after its custom role was deleted. */
  roleId: string | null;
  /** Key and name of the role the invite grants: from `roleId`, or null when the role was deleted. */
  roleKey: string | null;
  roleName: string | null;
  status: InviteStatus;
  /** The inviting user, or null when the inviter is an agent (Permissions P1 US-008). */
  invitedById: string | null;
  inviterName: string | null;
  acceptedByUserId: string | null;
  acceptedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * Fleet S4b US-004: `EXPIRED` is computed on read, a PENDING invite whose `expiresAt` has passed reads
 * as `EXPIRED` without touching the stored row. ACCEPTED and CANCELLED are final and never rewritten.
 */
export function effectiveStatus(record: ProjectInviteRecord, now: Date): InviteStatus {
  if (record.status === 'PENDING' && record.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  return record.status;
}

import { ActorRole } from '../../../common/enums';

/** Roles a user can hold through the membership API (AGENT/MEMBER are not assignable). */
export const PROJECT_MEMBER_ROLES = [ActorRole.ADMIN, ActorRole.DEVELOPER, ActorRole.VIEWER] as const;
export type ProjectMemberRole = (typeof PROJECT_MEMBER_ROLES)[number];

export interface ProjectMemberRecord {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  joinedAt: Date;
}

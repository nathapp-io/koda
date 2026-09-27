import { SetMetadata } from '@nestjs/common';

/**
 * Metadata key for the optional project-role gate applied by
 * ProjectMembershipGuard. The guard reads the value via Reflector and refuses a
 * user principal whose ProjectMember.role is not listed.
 *
 * KB write routes carry `@ProjectRoles('ADMIN', 'DEVELOPER', 'AGENT')` to refuse
 * a project VIEWER. Ticket and label routes use `@ProjectPermission` instead
 * (#144): their rules are CASL permissions derived from the project role.
 */
export const PROJECT_ROLES_KEY = 'koda:projectRoles';

export const ProjectRoles = (...roles: string[]) => SetMetadata(PROJECT_ROLES_KEY, roles);

import { SetMetadata } from '@nestjs/common';

/**
 * Metadata key for the optional project-role gate applied by
 * ProjectMembershipGuard. The guard reads the value via Reflector and refuses a
 * user principal whose ProjectMember.role is not listed.
 *
 * Tickets, comments and labels intentionally do not use this decorator:
 * project membership alone gates their visibility (Track 3 ruling 2026-09-27).
 * KB write routes are the only exception and carry `@ProjectRoles('ADMIN',
 * 'DEVELOPER', 'AGENT')` to refuse a project VIEWER.
 */
export const PROJECT_ROLES_KEY = 'koda:projectRoles';

export const ProjectRoles = (...roles: string[]) => SetMetadata(PROJECT_ROLES_KEY, roles);

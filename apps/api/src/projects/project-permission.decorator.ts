import { SetMetadata } from '@nestjs/common';
import type { CaslPermissionAction } from '@nathapp/nestjs-auth';

/**
 * #144: a project-scoped permission. Checked by ProjectMembershipGuard after it
 * resolved the caller's project role, with an ability built from
 * `{ ...principal, projectRole }`. Replaces @RequiredPermission on project
 * routes: the global PermissionAuthGuard runs before any route guard and has no
 * project context (nestjs-auth 3.3.0 permission.provider.js:70).
 *
 * `exemptAgents` keeps a route's pre-existing agent behaviour when the route
 * carried no permission before (ticket-label assign/remove).
 */
export const PROJECT_PERMISSION_KEY = 'koda:projectPermission';

export type ProjectPermissionTuple = [CaslPermissionAction, string];

export interface ProjectPermissionMetadata {
  permission: ProjectPermissionTuple;
  exemptAgents: boolean;
}

export const ProjectPermission = (
  permission: ProjectPermissionTuple,
  opts: { exemptAgents?: boolean } = {},
) =>
  SetMetadata<string, ProjectPermissionMetadata>(PROJECT_PERMISSION_KEY, {
    permission,
    exemptAgents: opts.exemptAgents ?? false,
  });

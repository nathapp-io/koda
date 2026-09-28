import { KodaPrincipal, isUserPrincipal } from '../auth/principal/koda-principal.types';

/**
 * Attached to the request by ProjectMembershipGuard after it resolved the
 * `:slug` project and the caller's membership once (#145, guard half).
 * `role` is 'ADMIN' for a global ADMIN, null for an agent (agents never use
 * project roles), otherwise the caller's raw ProjectMember.role.
 */
export interface ProjectContext {
  project: { id: string; slug: string };
  role: string | null;
}

export interface ProjectScopedRequest {
  params?: { slug?: string };
  user?: KodaPrincipal;
  projectContext?: ProjectContext;
}

/**
 * #144: the principal a project-scoped CASL check must use. Returns a new user
 * principal whose projectRole is the resolved membership role; agents and
 * role-less calls pass through unchanged.
 */
export function withProjectRole(principal: KodaPrincipal, role: string | null): KodaPrincipal {
  if (!isUserPrincipal(principal) || role === null) return principal;
  return { ...principal, projectRole: role };
}

import { KodaPrincipal } from '../auth/principal/koda-principal.types';

/**
 * Attached to the request by ProjectMembershipGuard after it resolved the `:slug` project and admitted
 * the caller to it. It carries the project's identity only: access is a permission key, and
 * permissions P1 (US-004) removed the project role from the request.
 */
export interface ProjectContext {
  project: { id: string; slug: string };
}

export interface ProjectScopedRequest {
  params?: { slug?: string };
  query?: Record<string, unknown>;
  body?: unknown;
  user?: KodaPrincipal;
  projectContext?: ProjectContext;
}

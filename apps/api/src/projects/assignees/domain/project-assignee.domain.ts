import type { IRepository } from '@nathapp/nestjs-data';

/**
 * S4c US-004: module-private DI token. `ProjectAssigneesModule` provides the
 * repository behind it and never exports it — the service is the module's only
 * public face.
 */
export const PROJECT_ASSIGNEES_REPOSITORY = Symbol('PROJECT_ASSIGNEES_REPOSITORY');

/** One entry of the assignee typeahead (S4c US-004 §3.3). */
export interface AssigneeDomain {
  type: 'user' | 'agent';
  /** The User.id, or the Agent.id for an agent. */
  id: string;
  name: string;
  /** Users: the email. Agents: the slug. */
  secondary: string;
  /** Agents only: ACTIVE | PAUSED. */
  status?: string;
}

/**
 * The project-membership row the repository's CRUD half speaks — a plain
 * interface owned here, never a Prisma-generated type.
 */
export interface ProjectMembershipDomain {
  id: string;
  projectId: string;
  userId: string;
  role: string;
  joinedAt: Date;
}

export interface IProjectAssigneesRepository extends IRepository<ProjectMembershipDomain, string> {
  /**
   * The combined assignee list: non-disabled project members first, then the
   * project's ACTIVE/PAUSED rostered agents, each group ordered by name.
   * `q` is a trimmed, case-insensitive substring of a name, email or slug;
   * `limit` caps the combined list.
   */
  search(projectId: string, q: string, limit: number): Promise<AssigneeDomain[]>;
}

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

export interface IProjectAssigneesRepository {
  /**
   * The combined assignee list: non-disabled users first, then ACTIVE/PAUSED agents
   * from the supplied project.read holders, each group ordered by name.
   * `q` is a trimmed, case-insensitive substring of a name, email or slug;
   * `limit` caps the combined list.
   */
  search(projectId: string, q: string, limit: number, ids: { userIds: string[]; agentIds: string[] }): Promise<AssigneeDomain[]>;
}

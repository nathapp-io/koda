/**
 * Review P2 remainder (US-001): the in-process project-lifecycle events.
 *
 * A project soft-delete has to quiesce what belongs to the project — the fleet jobs it left unstarted
 * (US-001 here), and later its VCS polling (US-002). Those live in other modules, so the delete emits
 * one event on `EventEmitter2` instead of importing them: `ProjectsModule` stays free of the fleet and
 * VCS graphs, and each listener subscribes on its own.
 *
 * The event is emitted **after** the delete's transaction committed, so a listener's transaction never
 * joins the delete's and a listener failure cannot roll the soft delete back.
 */

/** A project was soft-deleted. Emitted once per delete, after the commit. */
export const PROJECT_SOFT_DELETED = 'projects.project.soft-deleted';

export interface ProjectSoftDeletedEvent {
  /** The soft-deleted project. Its rows stay, so listeners change what points at them, never delete them. */
  readonly projectId: string;
}

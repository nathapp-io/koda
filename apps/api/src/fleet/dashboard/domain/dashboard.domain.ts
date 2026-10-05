import type { DashboardJobRow, DashboardRecentRow, DashboardRunnerRow, DashboardScope, PendingSummary } from '../dashboard.types';

export const DASHBOARD_REPOSITORY = Symbol('DASHBOARD_REPOSITORY');

/** A runner row before its capabilities are re-validated (spec §1.4). */
export interface RawRunnerRow extends Omit<DashboardRunnerRow, 'capabilities'> {
  capabilities: unknown;
}

/** S2b (c) spec §1.3: plain, non-locking reads. Scoped reads skip soft-deleted projects. */
export interface IDashboardRepository {
  /** Every runner, ordered by name then id. */
  findRunners(): Promise<RawRunnerRow[]>;
  /** Every runner-held job (ASSIGNED, RUNNING, UPLOADING) across all projects. */
  findHeldRefs(): Promise<Array<{ runnerId: string; repoId: string }>>;
  /** Active jobs in scope, oldest queuedAt first then id; at most `limit`. */
  findActiveJobs(scope: DashboardScope, limit: number): Promise<DashboardJobRow[]>;
  /** The globally oldest QUEUED jobs (any project, soft-deleted included): the window fillRunner scans (D407). */
  findQueuedWindow(limit: number): Promise<DashboardJobRow[]>;
  /** Terminal jobs in scope with finishedAt >= finishedSince, newest first then id; at most `limit`. */
  findRecentJobs(scope: DashboardScope, finishedSince: Date, limit: number): Promise<DashboardRecentRow[]>;
  /** Count per active state in scope. States with no job are absent. */
  countActiveByState(scope: DashboardScope): Promise<Map<string, number>>;
  /** Pending approvals per job (status pending, jobId set). Jobs with none are absent. */
  pendingSummaryByJob(jobIds: readonly string[]): Promise<PendingSummary[]>;
}

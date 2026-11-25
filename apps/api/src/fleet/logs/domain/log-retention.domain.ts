export const LOG_RETENTION_REPOSITORY = Symbol('LOG_RETENTION_REPOSITORY');

/** A terminal job whose logs are due; `leaseEpoch` is E, recorded at selection (spec §5). */
export interface RetentionCandidate {
  id: string;
  leaseEpoch: number;
  finishedAt: Date;
}

export interface RetentionCursor {
  finishedAt: Date;
  id: string;
}

/**
 * US-009 (finding 5): the file cleanup work a repository deletion captured before its cascade. The job, log
 * and artifact rows are gone, so the record is the only thing that still names the job's stored files.
 * `leaseEpoch` is the highest attempt whose log prefixes are targets, `finishedAt` keeps the retention cutoff
 * meaningful and `bundleKeys` are the exact storage keys to delete.
 */
export interface RetiredCleanupRecord {
  id: string;
  jobId: string;
  leaseEpoch: number;
  finishedAt: Date;
  bundleKeys: string[];
}

/** The (finishedAt, id) position a retired-cleanup page continues from. */
export interface RetiredCleanupCursor {
  finishedAt: Date;
  id: string;
}

export interface ILogRetentionRepository {
  /**
   * Plan D342: terminal jobs that finished before `before` and still have an unexpired FleetJobLog or
   * FleetJobArtifact row or any `log` event; ordered (finishedAt, id), strictly after `after`.
   */
  findCandidates(before: Date, after: RetentionCursor | null, limit: number): Promise<RetentionCandidate[]>;
  /** Storage keys of the job's unexpired artifacts with leaseEpoch <= maxEpoch. */
  findBundleKeys(jobId: string, maxEpoch: number): Promise<string[]>;
  /** Plan D344: inside the caller's transaction, under the job row lock. */
  expireRows(jobId: string, maxEpoch: number, now: Date): Promise<{ events: number; logs: number; artifacts: number }>;
  /**
   * US-009: the cleanup records a deleted repository left behind whose job finished before `before`, ordered
   * (finishedAt, id) and strictly after `after`, at most `limit` of them.
   */
  findRetiredCleanups(before: Date, after: RetiredCleanupCursor | null, limit: number): Promise<RetiredCleanupRecord[]>;
  /**
   * US-009: acknowledges one cleanup record. Called only after every one of its targets is deleted, so a
   * record that is still here is work that is still owed.
   */
  deleteRetiredCleanup(id: string): Promise<void>;
}

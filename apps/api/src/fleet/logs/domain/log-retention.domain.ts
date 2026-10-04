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
}

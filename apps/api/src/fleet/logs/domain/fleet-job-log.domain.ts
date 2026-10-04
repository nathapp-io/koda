export const LOG_STREAMS = ['run', 'stdout', 'stderr'] as const;
export type LogStreamName = (typeof LOG_STREAMS)[number];
export type LogSource = 'stream' | 'bundle';

export const isLogStream = (value: unknown): value is LogStreamName =>
  typeof value === 'string' && (LOG_STREAMS as readonly string[]).includes(value);

/** Spec §1.2. `sizeBytes` is a number (at most 256 MiB, safe). */
export interface FleetJobLogRecord {
  id: string;
  jobId: string;
  leaseEpoch: number;
  stream: LogStreamName;
  sizeBytes: number;
  complete: boolean;
  truncated: boolean;
  source: LogSource;
  expiredAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
}

export interface LogStreamPatch {
  sizeBytes: number;
  complete?: boolean;
  truncated?: boolean;
}

export const FLEET_JOB_LOG_REPOSITORY = Symbol('FLEET_JOB_LOG_REPOSITORY');

export interface IFleetJobLogRepository {
  findStream(jobId: string, leaseEpoch: number, stream: LogStreamName): Promise<FleetJobLogRecord | null>;
  listForAttempt(jobId: string, leaseEpoch: number): Promise<FleetJobLogRecord[]>;
  /** Caller holds LogStore.withLock for the stream's key. */
  upsertStream(jobId: string, leaseEpoch: number, stream: LogStreamName, patch: LogStreamPatch): Promise<FleetJobLogRecord>;
  /**
   * Caller holds the key lock. Sets source = bundle and the size; complete = !truncated. Only when the row is absent
   * or has complete = false and truncated = false. Returns whether it wrote.
   */
  completeFromBundle(jobId: string, leaseEpoch: number, stream: LogStreamName, r: { sizeBytes: number; truncated: boolean }): Promise<boolean>;
}

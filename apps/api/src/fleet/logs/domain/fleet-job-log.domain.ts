export const LOG_STREAMS = ['run', 'stdout', 'stderr'] as const;
export type LogStreamName = (typeof LOG_STREAMS)[number];
/** Fleet S5a: `thread` is uploaded by THREAD jobs and never read through the job-log routes. */
export const UPLOAD_STREAMS = [...LOG_STREAMS, 'thread'] as const;
export type UploadStreamName = (typeof UPLOAD_STREAMS)[number];
export type LogSource = 'stream' | 'bundle';

export const isLogStream = (value: unknown): value is LogStreamName =>
  typeof value === 'string' && (LOG_STREAMS as readonly string[]).includes(value);

export const isUploadStream = (value: unknown): value is UploadStreamName =>
  typeof value === 'string' && (UPLOAD_STREAMS as readonly string[]).includes(value);

/** Spec §1.2. `sizeBytes` is a number (at most 256 MiB, safe). */
export interface FleetJobLogRecord {
  id: string;
  jobId: string;
  leaseEpoch: number;
  stream: UploadStreamName;
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
  findStream(jobId: string, leaseEpoch: number, stream: UploadStreamName): Promise<FleetJobLogRecord | null>;
  listForAttempt(jobId: string, leaseEpoch: number): Promise<FleetJobLogRecord[]>;
  /** Every row of the job, latest epoch first (S2a §3.1). */
  listForJob(jobId: string): Promise<FleetJobLogRecord[]>;
  /** Epochs that have `log` timeline events (v1/v2 runners), latest first (S2a §3.1 legacySampled). */
  findLogEventEpochs(jobId: string): Promise<number[]>;
  /** Caller holds LogStore.withLock for the stream's key. */
  upsertStream(jobId: string, leaseEpoch: number, stream: UploadStreamName, patch: LogStreamPatch): Promise<FleetJobLogRecord>;
  /**
   * Caller holds the key lock. Sets source = bundle and the size; complete = !truncated. Only when the row is absent
   * or has complete = false and truncated = false. Returns whether it wrote.
   */
  completeFromBundle(jobId: string, leaseEpoch: number, stream: UploadStreamName, r: { sizeBytes: number; truncated: boolean }): Promise<boolean>;
}

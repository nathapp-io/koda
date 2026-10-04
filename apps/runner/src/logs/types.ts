import type { LogEventPayload } from '@nathapp/fleet-protocol';

/** S2a §1.1: the three streams of a job attempt. */
export type LogStreamName = LogEventPayload['stream'];

/** Slice 1a plan D307: every protocol outcome of an upload is an HTTP 200 carrying one of these. */
export type PutLogOutcome = 'appended' | 'duplicate' | 'offset' | 'complete' | 'stream_cap' | 'rate_limited';

export interface PutLogArgs {
  readonly jobId: string;
  readonly stream: LogStreamName;
  readonly leaseEpoch: number;
  readonly offset: number;
  readonly bytes: Uint8Array;
  readonly final: boolean;
  readonly signal?: AbortSignal;
}

/** Plan D322: a 2xx carries outcome and size; any other status carries only the status. */
export interface PutLogAnswer {
  readonly status: number;
  readonly outcome?: PutLogOutcome;
  readonly size?: number;
  readonly retryAfterMs?: number;
}

/** Built in daemon.ts over ServerClient.putLog (plan D321). Rejects on a network failure or an abort. */
export interface LogTransport {
  putLog(args: PutLogArgs): Promise<PutLogAnswer>;
}

/** Where a job's nax writes its logs (JobExecutor.logSources). `runLog` is false for PLAN jobs (spec §2.4). */
export interface JobLogSources {
  readonly outDir: string;
  readonly feature: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly runLog: boolean;
}

export type LogLifecycle = (level: 'info' | 'warn' | 'error', message: string) => void;

export interface LogJob {
  readonly jobId: string;
  readonly leaseEpoch: number;
  readonly sources: JobLogSources;
  readonly lifecycle: LogLifecycle;
}

export type DrainResult = 'drained' | 'timeout' | 'stopped';

/** What a JobRun needs from the runner-wide shipper (plan D321). Only `drain` returns a promise, and it never rejects. */
export interface LogShipping {
  register(job: LogJob): void;
  wake(jobId: string, leaseEpoch: number): void;
  /** Ships every stream of the job to its file end, then final=1 (spec §2.4 R5). */
  drain(jobId: string, leaseEpoch: number, timeoutMs: number): Promise<DrainResult>;
  /** Stops the job's streams, aborts their in-flight PUTs, resolves a pending drain with 'stopped', forgets the job. */
  stopJob(jobId: string, leaseEpoch: number): void;
}

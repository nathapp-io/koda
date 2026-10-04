import type { BundleFile } from '../bundle/build-bundle';
import type { JobLogSources } from '../logs/types';
import type { JobRow } from '../journal/types';
import type { PlanCheck } from '../verdict/plan-verdict';
import type { StatusView } from '../verdict/status-view';
import type { WatcherSink } from '../watcher/watcher';
import type { ProgressPushOutcome } from './progress-push';

export type PrepareOutcome = { ok: true; branch: string | null } | { ok: false; reason: string; cancelled?: true };

/** D66: polled between prepare steps; true ends prepare at that boundary with `cancelled: true`. */
export interface PrepareOptions {
  readonly isCancelled?: () => boolean;
}

/** Polled while the PLAN push waits for its first token; true ends the wait at once (the run feeds cancel and halt). */
export interface FinishPlanOptions {
  readonly isCancelled?: () => boolean;
}

/** S1b §1.1: polled while the progress push waits for a token or a retry; true (an ABANDON) stops it. Never a cancel. */
export interface PushProgressOptions {
  readonly isHalted?: () => boolean;
}

export interface SpawnHandle {
  readonly pid: number;
  readonly pgid: number;
}

export interface WatchOptions {
  readonly onRunIds?: (ids: { naxRunId: string; logPath: string | null }) => void;
}

export interface JobWatcher {
  tick(final?: boolean): Promise<void>;
}

export type PlanPushOutcome = { ok: true; branch: string; sha: string } | { ok: false; reason: string; cancelled?: true };

/**
 * Slice 3 design §1 `executor/`. 3a ships HostExecutor only; a container or VM executor implements the same seam
 * (S1 spec §5.5). Nothing here talks to the server: results are journal events written by the caller.
 */
export interface JobExecutor {
  prepare(job: JobRow, options?: PrepareOptions): Promise<PrepareOutcome>;
  spawn(job: JobRow): Promise<SpawnHandle>;
  isAlive(pid: number): boolean;
  matchesProcess(job: JobRow): Promise<boolean>;
  /** True when the signal reached the group (mirrors `signalGroup`'s contract). */
  kill(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean;
  reap(job: JobRow, since: Date): Promise<void>;
  createWatcher(job: JobRow, sink: WatcherSink, options: WatchOptions): JobWatcher;
  /** S2a §2.4, plan D321: where this job's nax writes its run log, stdout and stderr (no I/O). */
  logSources(job: JobRow): JobLogSources;
  readStatus(job: JobRow): Promise<StatusView | null>;
  readPlan(job: JobRow): Promise<PlanCheck>;
  /** #203: absolute spend from this PLAN attempt's cost ledgers, in snapshot decimal format. */
  readPlanCost(job: JobRow): Promise<string | undefined>;
  finishPlan(job: JobRow, options?: FinishPlanOptions): Promise<PlanPushOutcome>;
  /** S1b §1.1 (B5): after an unfinished RUN, commit the PRD and fast-forward the feature branch on origin. */
  pushProgress(job: JobRow, options?: PushProgressOptions): Promise<ProgressPushOutcome>;
  readFinishLedger(job: JobRow): Promise<{ branch: string; headSha: string } | null>;
  collectBundle(job: JobRow): Promise<BundleFile>;
  cleanup(job: JobRow): Promise<void>;
  /** D90: after a daemon restart, re-open this job's credential socket (a readopted nax may still push). */
  resumeCredentials(job: JobRow): Promise<void>;
  /** D90: close this epoch's credential socket and forget its token; other epochs of the job are untouched. */
  releaseCredentials(job: JobRow): Promise<void>;
  /** Plan D273: READOPT `watch` re-binds the job's approval receiver (no-op for raw jobs). */
  resumeApprovals(job: JobRow): Promise<void>;
  /** Plan D285: an abandoned epoch closes its own receiver even when a live higher epoch keeps the profile. */
  releaseApprovals(job: JobRow): Promise<void>;
}

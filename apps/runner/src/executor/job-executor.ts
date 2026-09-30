import type { BundleFile } from '../bundle/build-bundle';
import type { JobRow } from '../journal/types';
import type { PlanCheck } from '../verdict/plan-verdict';
import type { StatusView } from '../verdict/status-view';
import type { WatcherSink } from '../watcher/watcher';

export type PrepareOutcome = { ok: true; branch: string | null } | { ok: false; reason: string; cancelled?: true };

/** D66: polled between prepare steps; true ends prepare at that boundary with `cancelled: true`. */
export interface PrepareOptions {
  readonly isCancelled?: () => boolean;
}

export interface SpawnHandle {
  readonly pid: number;
  readonly pgid: number;
}

export interface WatchOptions {
  readonly startAtEnd: boolean;
  readonly onRunIds?: (ids: { naxRunId: string; logPath: string | null }) => void;
}

export interface JobWatcher {
  tick(final?: boolean): Promise<void>;
}

export type PlanPushOutcome = { ok: true; branch: string; sha: string } | { ok: false; reason: string; resume?: { branch: string; sha: string } };

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
  readStatus(job: JobRow): Promise<StatusView | null>;
  readPlan(job: JobRow): Promise<PlanCheck>;
  finishPlan(job: JobRow): Promise<PlanPushOutcome>;
  readFinishLedger(job: JobRow): Promise<{ branch: string; headSha: string } | null>;
  collectBundle(job: JobRow): Promise<BundleFile>;
  cleanup(job: JobRow): Promise<void>;
}

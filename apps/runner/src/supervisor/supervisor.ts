import { isConfigKind, isThreadKind, type FleetCommandOut, type ThreadCommandType } from '@nathapp/fleet-protocol';
import { isFinalStatus, type StatusView } from '../verdict/status-view';
import { canAcceptCancel, JobRun, type JobRunDeps, type RunStart } from './job-run';
import { JobEvents } from './job-events';
import { killIfOurs } from './kill-if-ours';
import { isTerminalState } from './transitions';
import { ThreadJobRun, type ThreadCommandOutcome, type ThreadRunDeps, type ThreadRunSetup } from '../thread/thread-job-run';
import type { JobRow } from '../journal/types';
import { errorMessage } from '../errors';

export interface SupervisorDeps extends JobRunDeps {
  readonly readoptHeartbeatMs: number;
  /** Fleet S5a §5: present when this runner hosts THREAD jobs; absent, a THREAD row fails `backend_unavailable`. */
  readonly threads?: ThreadRunSetup;
}

export type ReadoptResult = { result: 'ok' | 'rejected'; detail?: string };

/**
 * Finding 8 (US-006): what a CANCEL delivery decided. `refused` means the job has passed the cancellation cutoff
 * (it is UPLOADING or terminal), so the ack reports a rejection instead of an ok for a run that finishes on its own
 * verdict. `unknown` stays the "this runner holds no such job" answer.
 */
export type CancelDecision = 'ok' | 'unknown' | 'refused';

/**
 * B2: handed the outcome INSIDE the journal transaction that finalizes a rejected row, so the row's `doneAt` and the
 * durable record of the rejection commit together. A crash between them used to leave a done row beside a stale `ok`
 * record, and the next boot's replay then acked `ok` for a job nobody supervised (K10).
 */
export type ReadoptFinalize = (outcome: ReadoptResult) => void;

const OK: ReadoptResult = { result: 'ok' };

/** One run in the map: a nax job, or (Fleet S5a) a thread session. Both start, halt and abandon the same way. */
type ActiveRun = JobRun | ThreadJobRun;

/** Owns one run per active (job, epoch) and turns server commands into run operations (design §1). */
export class Supervisor {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly pending = new Set<Promise<void>>();
  /** US-001: the retirement of one (job, epoch); every caller joins the same one. */
  private readonly retirements = new Map<string, Promise<void>>();

  constructor(private readonly deps: SupervisorDeps) {}

  private key(jobId: string, epoch: number): string {
    return `${jobId}:${epoch}`;
  }

  private track(key: string, run: ActiveRun, from: RunStart, after?: Promise<void>): void {
    this.runs.set(key, run);
    // K11: a THREAD row starts at once — retiring an older THREAD row never takes the repo mutex, so it ignores `after`.
    const started = run instanceof JobRun ? run.start(from, after) : run.start(from);
    const promise: Promise<void> = started.finally(() => {
      this.runs.delete(key);
      this.pending.delete(promise);
    });
    this.pending.add(promise);
  }

  private threadDeps(threads: ThreadRunSetup): ThreadRunDeps {
    return {
      journal: this.deps.journal, log: this.deps.log, now: this.deps.now, sleep: this.deps.sleep,
      mutex: this.deps.mutex, logs: this.deps.logs,
      host: threads.host, tuning: threads.tuning,
    };
  }

  /**
   * US-001: the retirement of one (job, epoch), shared by every caller. An explicit ABANDON and an unknown-job cleanup
   * of the same epoch run the cleanup once, and a repeated command joins the first retirement instead of starting a
   * second one. The target is halted at once (the abandon below starts synchronously); the cleanup itself waits for
   * the repo mutex, off the polling path. The promise settles when the cleanup is done and is part of `idle()`.
   */
  retire(jobId: string, leaseEpoch: number): Promise<void> {
    const key = this.key(jobId, leaseEpoch);
    const existing = this.retirements.get(key);
    if (existing) return existing;
    const promise: Promise<void> = this.abandon(jobId, leaseEpoch).finally(() => {
      this.retirements.delete(key);
      this.pending.delete(promise);
    });
    this.retirements.set(key, promise);
    this.pending.add(promise);
    return promise;
  }

  /**
   * US-001: the epochs of a job the server does not know, captured now and retired in the background. A lease that
   * arrives after this snapshot is not part of the sweep, so a later epoch cannot be pulled into an earlier one.
   */
  retireUnknown(jobId: string): void {
    for (const row of this.deps.journal.jobsById(jobId)) {
      void this.retire(jobId, row.leaseEpoch).catch((error: unknown) => {
        this.deps.log.warn('unknown job abandon failed', { jobId, leaseEpoch: row.leaseEpoch, error: errorMessage(error) });
      });
    }
  }

  /**
   * K11/D64: the older epochs of this job, retired off the caller's path. A row that is done is dropped here and now —
   * its run already called `executor.cleanup` (which closed the approval relay and released the job's credentials) and
   * the new epoch's prepare wipes the previous attempt's files (D53). Any other row goes through `abandon`, which still
   * takes the repo mutex; the caller never waits for that, and neither does `CommandHandler.assign`. The returned promise
   * settles once every abandon has settled, never rejects (a failed abandon is reported), and is part of `idle()`.
   */
  retireOlderEpochs(jobId: string, leaseEpoch: number): Promise<void> {
    const unsettled: number[] = [];
    for (const older of this.deps.journal.jobsById(jobId)) {
      if (older.leaseEpoch >= leaseEpoch) continue;
      if (older.doneAt !== null) this.deps.journal.abandon(jobId, older.leaseEpoch);
      else unsettled.push(older.leaseEpoch);
    }
    if (unsettled.length === 0) return Promise.resolve();
    const retiring = (async (): Promise<void> => {
      for (const epoch of unsettled) {
        try {
          await this.retire(jobId, epoch);
        } catch (error) {
          this.deps.log.warn('older epoch abandon failed', { jobId, leaseEpoch: epoch, error: errorMessage(error) });
        }
      }
    })();
    const promise: Promise<void> = retiring.finally(() => this.pending.delete(promise));
    this.pending.add(promise);
    return promise;
  }

  /** K11: `after` settles before the new run even asks for the repo mutex, so a requeue never waits for it inline. */
  begin(row: JobRow, from: RunStart, after?: Promise<void>): void {
    const key = this.key(row.jobId, row.leaseEpoch);
    if (this.runs.has(key)) return;
    // K11/D64 and B1: `'prepare'` comes from an ASSIGN, which passes its own retirement promise. `'reprepare'` is a
    // RECOVERY start — an ASSIGN replay or a READOPT of an ASSIGNED row — found after a restart, so the retirement the
    // crashed daemon still held is gone with it. Rebuilding it here is what keeps retirement-before-prepare across a
    // restart: without it the new epoch would prepare on the checkout while the older epoch's detached nax still ran.
    const retiring = after ?? (from === 'reprepare' ? this.retireOlderEpochs(row.jobId, row.leaseEpoch) : undefined);
    if (!isThreadKind(row.command)) {
      this.track(key, new JobRun(this.deps, row.jobId, row.leaseEpoch), from, retiring);
      return;
    }
    const threads = this.deps.threads;
    if (!threads) {
      // No thread host on this runner: nothing can serve the row, so it ends before it ever starts.
      new JobEvents(this.deps.journal, row.jobId, row.leaseEpoch, this.deps.log).transition('FAILED', 'backend_unavailable');
      this.deps.journal.markDone(row.jobId, row.leaseEpoch);
      return;
    }
    this.track(key, new ThreadJobRun(this.threadDeps(threads), row.jobId, row.leaseEpoch), from);
  }

  /** Fleet S5a §5: a THREAD command reaches the run that holds the (job, epoch); any other row is not held. */
  async threadCommand(command: FleetCommandOut): Promise<ThreadCommandOutcome> {
    const row = this.deps.journal.getJob(command.jobId, command.leaseEpoch);
    if (row === null || isTerminalState(row.state) || row.doneAt !== null) return { result: 'rejected', detail: 'does not hold job' };
    const run = this.runs.get(this.key(command.jobId, command.leaseEpoch));
    if (!(run instanceof ThreadJobRun)) return { result: 'rejected', detail: 'does not hold job' };
    return run.command(command.type as ThreadCommandType, command.payload);
  }

  cancel(jobId: string, leaseEpoch: number): CancelDecision {
    const run = this.runs.get(this.key(jobId, leaseEpoch));
    if (run) {
      // The run owns the decision: a JobRun refuses once its finish path has committed the upload cutoff, a thread
      // session run keeps its own rule (US-007).
      return run.requestCancel() ? 'ok' : 'refused';
    }
    const row = this.deps.journal.getJob(jobId, leaseEpoch);
    if (!row) return 'unknown';
    // No run yet (the daemon just restarted): record the cancel; READOPT validates the process before anything is
    // signalled. Finding 8 (US-006): a RUN past its upload cutoff (UPLOADING, terminal) refuses without mutating the
    // journal — it is turned into CANCELLED server-side only when the cancellation takes effect. No other command kind
    // is cut off; a terminal row of any kind refuses.
    if (!canAcceptCancel(row)) return 'refused';
    if (row.cancelRequestedAt === null) {
      this.deps.journal.updateJob(jobId, leaseEpoch, { cancelRequestedAt: this.deps.now().toISOString() });
    }
    return 'ok';
  }

  async abandon(jobId: string, leaseEpoch: number): Promise<void> {
    const run = this.runs.get(this.key(jobId, leaseEpoch));
    if (run) {
      await run.abandon();
      return;
    }
    const row = this.deps.journal.getJob(jobId, leaseEpoch);
    if (!row) return;
    // Fleet S5a §5: a THREAD row owns no clone and no nax, so there is nothing to reap, clean or queue behind
    // the repo mutex — the row goes and the job's socket, token and shims with it.
    if (isThreadKind(row.command)) {
      this.deps.journal.abandon(jobId, leaseEpoch);
      await this.releaseThreadCredentials(row);
      return;
    }
    // No run in memory (after a restart): the same epoch-safe abandon, on a run that never started (D64).
    await new JobRun(this.deps, jobId, leaseEpoch).abandon();
  }

  /** A release that fails is reported and never held against a row that is already gone. */
  private async releaseThreadCredentials(row: JobRow): Promise<void> {
    const threads = this.deps.threads;
    if (!threads) return;
    try {
      await threads.host.credentials.release(row);
    } catch (error) {
      this.deps.log.warn('credential release failed', { jobId: row.jobId, error: errorMessage(error) });
    }
  }

  private fresh(status: StatusView): boolean {
    // D75: the 2-minute freshness window is a child-side contract; the journal row's `updatedAt` is a runner-side
    // write timestamp, so it never counts. D77: both status.json stamps are nax-written. nax sets `lastHeartbeat`
    // only on its 60s heartbeat write and drops it on every other status write, which still bumps `updatedAt`.
    const stamps = [status.lastHeartbeat, status.updatedAt].map((value) => (value ? Date.parse(value) : Number.NaN)).filter((ms) => !Number.isNaN(ms));
    if (stamps.length === 0) return false;
    return this.deps.now().getTime() - Math.max(...stamps) < this.deps.readoptHeartbeatMs;
  }

  private async reject(row: JobRow, detail: string, finalize?: ReadoptFinalize): Promise<ReadoptResult> {
    try {
      await killIfOurs(this.deps.executor, row, this.deps.log);   // SEC-2: void return (D65)
      await this.deps.executor.reap(row, new Date(row.createdAt));
      await this.deps.executor.cleanup(row);
    } catch (error) {
      this.deps.log.warn('readopt cleanup failed', { jobId: row.jobId, error: errorMessage(error) });
    }
    const outcome: ReadoptResult = { result: 'rejected', detail };
    // B2: the row's `doneAt` and whatever `finalize` records are ONE durable step, so a crash cannot leave a finalized
    // row beside a stale outcome; a crash inside it rolls both back and the next boot re-applies the command.
    this.deps.journal.tx(() => {
      this.deps.journal.markDone(row.jobId, row.leaseEpoch);
      finalize?.(outcome);
    });
    return outcome;
  }

  /** Fleet S5a §5: a thread job cannot be resumed — a session lives only in the daemon that opened it. */
  private readoptThread(row: JobRow, finalize?: ReadoptFinalize): ReadoptResult {
    if (isTerminalState(row.state)) {
      this.deps.journal.markDone(row.jobId, row.leaseEpoch);
      return OK;
    }
    if (row.state === 'ASSIGNED' && row.pid === null) {
      this.begin(row, 'reprepare');
      return OK;
    }
    const outcome: ReadoptResult = { result: 'rejected', detail: 'thread session ended by a runner restart' };
    this.deps.journal.tx(() => {                                 // B2: the same one durable step as `reject`
      this.deps.journal.markDone(row.jobId, row.leaseEpoch);
      finalize?.(outcome);
    });
    return outcome;
  }

  /** S1 spec §5.3 and design §2 control paths; D33 and D54 cover the cases the design leaves open. */
  async readopt(jobId: string, leaseEpoch: number, finalize?: ReadoptFinalize): Promise<ReadoptResult> {
    const row = this.deps.journal.getJob(jobId, leaseEpoch);
    if (!row) return { result: 'rejected', detail: 'unknown job' };
    if (this.runs.has(this.key(jobId, leaseEpoch))) return OK;
    // Fleet S5a §5: a restarted runner holds no session, so a THREAD row never goes through the nax readopt path.
    if (isThreadKind(row.command)) return this.readoptThread(row, finalize);
    if (isTerminalState(row.state)) {
      await this.deps.executor.cleanup(row).catch(() => undefined);
      this.deps.journal.markDone(jobId, leaseEpoch);
      return OK;
    }
    if (row.state === 'ASSIGNED' && row.pid === null) {
      this.begin(row, 'reprepare');   // D33, D65: every prepare step is idempotent; reap first in case a nax was spawned before the crash
      return OK;
    }
    // D485: a config job's work happens inside this daemon's process (no detached nax to watch), so a restart ends it;
    // the server marks it CRASHED and a requeue starts it over on a fresh lease.
    if (isConfigKind(row.command)) return this.reject(row, 'config job interrupted by a runner restart', finalize);
    if (row.pid === null) return this.reject(row, 'no process recorded', finalize);
    const alive = this.deps.executor.isAlive(row.pid);
    // fleet-agent-job US-007: an AGENT writes no status.json and has no nax run id, so it resumes exactly like PLAN,
    // REVIEW and FIX — a live process of ours is watched, a gone one finishes.
    if (row.command === 'PLAN' || row.command === 'REVIEW' || row.command === 'FIX' || row.command === 'AGENT') {
      const ours = alive && (await this.deps.executor.matchesProcess(row));
      this.begin(row, ours ? 'watch' : 'finish');
      return OK;
    }
    const status = await this.deps.executor.readStatus(row);
    const matches = status !== null && row.naxRunId !== null && status.run.id === row.naxRunId;
    if (status && matches && alive && this.fresh(status)) {
      this.begin(row, 'watch');
      return OK;
    }
    if (status && matches && !alive && isFinalStatus(status)) {
      this.begin(row, 'finish');
      return OK;
    }
    return this.reject(row, !matches ? 'run id mismatch' : alive ? 'stale heartbeat' : 'process gone', finalize);
  }

  shutdown(): void {
    for (const run of this.runs.values()) run.halt();
  }

  async idle(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }
}

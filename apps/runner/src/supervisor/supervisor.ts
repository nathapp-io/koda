import { isConfigKind, isThreadKind, type FleetCommandOut, type ThreadCommandType } from '@nathapp/fleet-protocol';
import { isFinalStatus, type StatusView } from '../verdict/status-view';
import { JobRun, type JobRunDeps, type RunStart } from './job-run';
import { JobEvents } from './job-events';
import { killIfOurs } from './kill-if-ours';
import { isTerminalState } from './transitions';
import { ThreadJobRun, type ThreadCommandOutcome, type ThreadRunDeps, type ThreadRunSetup } from './thread-job-run';
import type { JobRow } from '../journal/types';
import { errorMessage } from '../errors';

export interface SupervisorDeps extends JobRunDeps {
  readonly readoptHeartbeatMs: number;
  /** Fleet S5a §5: present when this runner hosts THREAD jobs; absent, a THREAD row fails `backend_unavailable`. */
  readonly threads?: ThreadRunSetup;
}

export type ReadoptResult = { result: 'ok' | 'rejected'; detail?: string };

const OK: ReadoptResult = { result: 'ok' };

/** One run in the map: a nax job, or (Fleet S5a) a thread session. Both start, halt and abandon the same way. */
type ActiveRun = JobRun | ThreadJobRun;

/** Owns one run per active (job, epoch) and turns server commands into run operations (design §1). */
export class Supervisor {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly pending = new Set<Promise<void>>();
  private readonly threadPending = new Set<Promise<void>>();

  constructor(private readonly deps: SupervisorDeps) {}

  private key(jobId: string, epoch: number): string {
    return `${jobId}:${epoch}`;
  }

  private track(key: string, run: ActiveRun, from: RunStart): void {
    this.runs.set(key, run);
    const isThread = run instanceof ThreadJobRun;
    const promise: Promise<void> = run.start(from).finally(() => {
      this.runs.delete(key);
      this.pending.delete(promise);
      this.threadPending.delete(promise);
    });
    this.pending.add(promise);
    if (isThread) this.threadPending.add(promise);
  }

  private threadDeps(threads: ThreadRunSetup): ThreadRunDeps {
    return {
      journal: this.deps.journal, log: this.deps.log, now: this.deps.now, sleep: this.deps.sleep,
      mutex: this.deps.mutex, logs: this.deps.logs,
      host: { ...threads.host, sessions: (threads as ThreadRunSetup & { sessions?: ThreadRunSetup['host']['sessions'] }).sessions ?? threads.host.sessions }, tuning: threads.tuning,
    };
  }

  begin(row: JobRow, from: RunStart): void {
    const key = this.key(row.jobId, row.leaseEpoch);
    if (this.runs.has(key)) return;
    if (!isThreadKind(row.command)) {
      this.track(key, new JobRun(this.deps, row.jobId, row.leaseEpoch), from);
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

  cancel(jobId: string, leaseEpoch: number): 'ok' | 'unknown' {
    const run = this.runs.get(this.key(jobId, leaseEpoch));
    if (run) {
      run.requestCancel();
      return 'ok';
    }
    const row = this.deps.journal.getJob(jobId, leaseEpoch);
    if (!row) return 'unknown';
    // No run yet (the daemon just restarted): record the cancel; READOPT validates the process before anything is signalled.
    if (!isTerminalState(row.state) && row.cancelRequestedAt === null) {
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

  async abandonAll(jobId: string): Promise<void> {
    for (const row of this.deps.journal.jobsById(jobId)) await this.abandon(jobId, row.leaseEpoch);
  }

  private fresh(status: StatusView): boolean {
    // D75: the 2-minute freshness window is a child-side contract; the journal row's `updatedAt` is a runner-side
    // write timestamp, so it never counts. D77: both status.json stamps are nax-written. nax sets `lastHeartbeat`
    // only on its 60s heartbeat write and drops it on every other status write, which still bumps `updatedAt`.
    const stamps = [status.lastHeartbeat, status.updatedAt].map((value) => (value ? Date.parse(value) : Number.NaN)).filter((ms) => !Number.isNaN(ms));
    if (stamps.length === 0) return false;
    return this.deps.now().getTime() - Math.max(...stamps) < this.deps.readoptHeartbeatMs;
  }

  private async reject(row: JobRow, detail: string): Promise<ReadoptResult> {
    try {
      await killIfOurs(this.deps.executor, row, this.deps.log);   // SEC-2: void return (D65)
      await this.deps.executor.reap(row, new Date(row.createdAt));
      await this.deps.executor.cleanup(row);
    } catch (error) {
      this.deps.log.warn('readopt cleanup failed', { jobId: row.jobId, error: errorMessage(error) });
    }
    this.deps.journal.markDone(row.jobId, row.leaseEpoch);
    return { result: 'rejected', detail };
  }

  /** Fleet S5a §5: a thread job cannot be resumed — a session lives only in the daemon that opened it. */
  private readoptThread(row: JobRow): ReadoptResult {
    if (isTerminalState(row.state)) {
      this.deps.journal.markDone(row.jobId, row.leaseEpoch);
      return OK;
    }
    if (row.state === 'ASSIGNED' && row.pid === null) {
      this.begin(row, 'reprepare');
      return OK;
    }
    this.deps.journal.markDone(row.jobId, row.leaseEpoch);
    return { result: 'rejected', detail: 'thread session ended by a runner restart' };
  }

  /** S1 spec §5.3 and design §2 control paths; D33 and D54 cover the cases the design leaves open. */
  async readopt(jobId: string, leaseEpoch: number): Promise<ReadoptResult> {
    const row = this.deps.journal.getJob(jobId, leaseEpoch);
    if (!row) return { result: 'rejected', detail: 'unknown job' };
    if (this.runs.has(this.key(jobId, leaseEpoch))) return OK;
    // Fleet S5a §5: a restarted runner holds no session, so a THREAD row never goes through the nax readopt path.
    if (isThreadKind(row.command)) return this.readoptThread(row);
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
    if (isConfigKind(row.command)) return this.reject(row, 'config job interrupted by a runner restart');
    if (row.pid === null) return this.reject(row, 'no process recorded');
    const alive = this.deps.executor.isAlive(row.pid);
    if (row.command === 'PLAN') {
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
    return this.reject(row, !matches ? 'run id mismatch' : alive ? 'stale heartbeat' : 'process gone');
  }

  shutdown(): void {
    for (const run of this.runs.values()) run.halt();
  }

  async idle(): Promise<void> {
    // Thread sessions intentionally remain live after setup; idle waits for their ASSIGNED startup to settle,
    // but not for the session itself to close.
    while (this.threadPending.size > 0 && this.deps.journal.activeJobs().some((row) => row.command === 'THREAD' && row.state === 'ASSIGNED')) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await Promise.allSettled([...this.pending].filter((promise) => !this.threadPending.has(promise)));
  }
}

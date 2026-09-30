import { isFinalStatus, type StatusView } from '../verdict/status-view';
import { JobRun, type JobRunDeps, type RunStart } from './job-run';
import { killIfOurs } from './kill-if-ours';
import { isTerminalState } from './transitions';
import type { JobRow } from '../journal/types';
import { errorMessage } from '../errors';

export interface SupervisorDeps extends JobRunDeps {
  readonly readoptHeartbeatMs: number;
}

export type ReadoptResult = { result: 'ok' | 'rejected'; detail?: string };

const OK: ReadoptResult = { result: 'ok' };

/** Owns one `JobRun` per active (job, epoch) and turns server commands into run operations (design §1). */
export class Supervisor {
  private readonly runs = new Map<string, JobRun>();
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly deps: SupervisorDeps) {}

  private key(jobId: string, epoch: number): string {
    return `${jobId}:${epoch}`;
  }

  begin(row: JobRow, from: RunStart): void {
    const key = this.key(row.jobId, row.leaseEpoch);
    if (this.runs.has(key)) return;
    const run = new JobRun(this.deps, row.jobId, row.leaseEpoch);
    this.runs.set(key, run);
    const promise: Promise<void> = run.start(from).finally(() => {
      this.runs.delete(key);
      this.pending.delete(promise);
    });
    this.pending.add(promise);
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
    if (!this.deps.journal.getJob(jobId, leaseEpoch)) return;
    // No run in memory (after a restart): the same epoch-safe abandon, on a run that never started (D64).
    await new JobRun(this.deps, jobId, leaseEpoch).abandon();
  }

  async abandonAll(jobId: string): Promise<void> {
    for (const row of this.deps.journal.jobsById(jobId)) await this.abandon(jobId, row.leaseEpoch);
  }

  private fresh(status: StatusView): boolean {
    // D75: the 2-minute freshness window is a child-side heartbeat contract; the runner's own `updatedAt`
    // is a write timestamp (cancel-requested patches, event-append patches), not a heartbeat, so falling back to
    // it silently accepted a wedged nax after any unrelated runner-side write.
    if (!status.lastHeartbeat) return false;
    const stamp = Date.parse(status.lastHeartbeat);
    return !Number.isNaN(stamp) && this.deps.now().getTime() - stamp < this.deps.readoptHeartbeatMs;
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

  /** S1 spec §5.3 and design §2 control paths; D33 and D54 cover the cases the design leaves open. */
  async readopt(jobId: string, leaseEpoch: number): Promise<ReadoptResult> {
    const row = this.deps.journal.getJob(jobId, leaseEpoch);
    if (!row) return { result: 'rejected', detail: 'unknown job' };
    if (this.runs.has(this.key(jobId, leaseEpoch))) return OK;
    if (isTerminalState(row.state)) {
      await this.deps.executor.cleanup(row).catch(() => undefined);
      this.deps.journal.markDone(jobId, leaseEpoch);
      return OK;
    }
    if (row.state === 'ASSIGNED' && row.pid === null) {
      this.begin(row, 'reprepare');   // D33, D65: every prepare step is idempotent; reap first in case a nax was spawned before the crash
      return OK;
    }
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
    await Promise.allSettled([...this.pending]);
  }
}

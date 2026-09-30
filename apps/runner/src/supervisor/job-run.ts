import type { SnapshotEventPayload, StateEventPayload } from '@nathapp/fleet-protocol';
import type { BundleFile } from '../bundle/build-bundle';
import type { UploadOutcome } from '../bundle/upload-bundle';
import { errorMessage } from '../errors';
import type { JobExecutor, JobWatcher } from '../executor/job-executor';
import type { Journal } from '../journal/journal';
import type { JobRow } from '../journal/types';
import type { Logger } from '../logger';
import type { Now, Sleep } from '../time';
import { planVerdict } from '../verdict/plan-verdict';
import { runVerdict, type Verdict } from '../verdict/run-verdict';
import { mapStatusToSnapshot } from '../watcher/status-snapshot';
import { JobEvents } from './job-events';
import { killIfOurs } from './kill-if-ours';
import type { RepoMutex } from './repo-mutex';
import { isTerminalState } from './transitions';

export interface BundleUploader {
  upload(job: JobRow, file: BundleFile, rebuild: () => Promise<BundleFile>): Promise<UploadOutcome>;
}

export interface JobRunTuning {
  readonly statusPollMs: number;
  readonly killGraceMs: number;
  /** D60: how often, and for how long, the run waits for the server to ack its UPLOADING event. 0 waits for nothing. */
  readonly ackPollMs: number;
  readonly uploadAckWaitMs: number;
}

export interface JobRunDeps {
  readonly journal: Journal;
  readonly executor: JobExecutor;
  readonly mutex: RepoMutex;
  readonly uploader: BundleUploader;
  readonly log: Logger;
  readonly now: Now;
  readonly sleep: Sleep;
  readonly tuning: JobRunTuning;
}

export type RunStart = 'prepare' | 'reprepare' | 'watch' | 'finish';

const TICK_WARN_EVERY = 30;
const PENDING_SCAN_LIMIT = 100_000;

function terminalReason(verdict: Verdict, outcome: UploadOutcome): string | undefined {
  if (outcome.kind === 'too-large') return 'bundle too large';
  if (outcome.kind === 'failed') return verdict.state === 'FAILED' && verdict.reason ? `${verdict.reason}; bundle upload failed` : 'bundle upload failed';
  return verdict.reason ?? undefined;
}

/** One job, from ASSIGN to cleanup (design §2). Only legal S1 §5.4 transitions are ever emitted (JobEvents refuses the rest). */
export class JobRun {
  private readonly events: JobEvents;
  private cancelSentAtMs: number | null = null;
  private sigkilled = false;
  private halted = false;
  private queued = false;
  private tickErrors = 0;

  constructor(private readonly deps: JobRunDeps, readonly jobId: string, readonly leaseEpoch: number) {
    this.events = new JobEvents(deps.journal, jobId, leaseEpoch, deps.log);
  }

  private row(): JobRow | null {
    return this.deps.journal.getJob(this.jobId, this.leaseEpoch);
  }

  private mustRow(): JobRow {
    const row = this.row();
    if (!row) throw new Error('job row is gone');
    return row;
  }

  async start(from: RunStart): Promise<void> {
    const first = this.row();
    if (!first) return;
    this.queued = from === 'prepare' || from === 'reprepare';
    const release = await this.deps.mutex.acquire(first.repoKey);
    this.queued = false;
    try {
      const current = this.row();
      if (current === null || current.doneAt !== null) return;   // abandoned, or cancelled while queued (D66)
      await this.lifecycle(from);
    } catch (error) {
      await this.failSafe(error);
    } finally {
      release();
    }
  }

  private async lifecycle(from: RunStart): Promise<void> {
    if ((from === 'prepare' || from === 'reprepare') && !(await this.prepareAndSpawn(from === 'reprepare'))) return;
    if (from === 'watch') await this.resumeCredentials();
    if (from !== 'finish') await this.watchUntilExit(from === 'watch');
    if (this.halted) return;
    await this.finish();
  }

  /** D90: a readopted nax may still push; its socket died with the previous daemon. A failure is reported, not fatal. */
  private async resumeCredentials(): Promise<void> {
    const row = this.row();
    if (!row) return;
    try {
      await this.deps.executor.resumeCredentials(row);
    } catch (error) {
      this.events.lifecycle('warn', `git credentials could not be restored: ${errorMessage(error)}`);
    }
  }

  requestCancel(): boolean {
    const row = this.row();
    if (!row || isTerminalState(row.state)) return false;
    if (this.queued && row.state === 'ASSIGNED') {
      this.endWhileQueued();
      return true;
    }
    if (row.cancelRequestedAt === null) this.deps.journal.updateJob(this.jobId, this.leaseEpoch, { cancelRequestedAt: this.deps.now().toISOString() });
    if (row.state === 'RUNNING') this.sendTerm(row);
    return true;
  }

  /** D66: still waiting for the repo mutex, nothing prepared: end at once and free the slot. `start` sees `doneAt` and lets go. */
  private endWhileQueued(): void {
    this.deps.journal.updateJob(this.jobId, this.leaseEpoch, { cancelRequestedAt: this.deps.now().toISOString() });
    this.events.transition('CANCELLED', 'cancelled before start');
    this.deps.journal.markDone(this.jobId, this.leaseEpoch);
  }

  private sendTerm(row: JobRow): void {
    if (this.cancelSentAtMs !== null || row.pgid === null) return;
    this.deps.executor.kill(row.pgid, 'SIGTERM');
    this.cancelSentAtMs = this.deps.now().getTime();
  }

  private cancelRequested(): boolean {
    return this.row()?.cancelRequestedAt != null;
  }

  halt(): void {
    this.halted = true;
  }

  private async reapQuietly(row: JobRow): Promise<void> {
    await this.deps.executor.reap(row, new Date(row.createdAt)).catch((error) => {
      this.deps.log.warn('reap failed', { jobId: this.jobId, error: errorMessage(error) });
    });
  }

  private higherEpochLive(): boolean {
    return this.deps.journal.jobsById(this.jobId).some((other) => other.leaseEpoch > this.leaseEpoch && other.doneAt === null);
  }

  async abandon(): Promise<void> {
    this.halted = true;
    const row = this.row();
    if (!row) return;
    // The halted run lets go of the repo mutex as soon as it notices; cleanup must not overlap another job's prepare.
    const release = await this.deps.mutex.acquire(row.repoKey);
    try {
      const current = this.row();
      if (current) await this.abandonCleanup(current);
    } finally {
      this.deps.journal.abandon(this.jobId, this.leaseEpoch);
      release();
    }
  }

  private async abandonCleanup(row: JobRow): Promise<void> {
    try {
      await killIfOurs(this.deps.executor, row, this.deps.log);   // SEC-2: returns void; the matchesProcess=false branch is intentionally silent (D65)
      // D90: the socket is per epoch, so it closes even when a live higher epoch keeps the reap and the profile.
      await this.deps.executor.releaseCredentials(row).catch((error: unknown) => {
        this.deps.log.warn('credential release failed', { jobId: this.jobId, error: errorMessage(error) });
      });
      if (this.higherEpochLive()) {
        this.deps.log.info('abandon leaves reap and cleanup to the live higher epoch', { jobId: this.jobId, leaseEpoch: this.leaseEpoch });
        return;
      }
      await this.deps.executor.reap(row, new Date(row.createdAt));
      await this.deps.executor.cleanup(row);
    } catch (error) {
      this.deps.log.warn('abandon cleanup failed', { jobId: this.jobId, error: errorMessage(error) });
    }
  }

  private async prepareAndSpawn(reprepare: boolean): Promise<boolean> {
    const row = this.mustRow();
    if (this.cancelRequested()) return this.endBeforeSpawn('CANCELLED', 'cancelled before start');
    if (reprepare) await this.reapQuietly(row);   // D65: a nax spawned just before the crash may have registered pids
    const prepared = await this.deps.executor.prepare(row, { isCancelled: () => this.cancelRequested() });
    if (this.halted) return false;
    if (!prepared.ok) return prepared.cancelled ? this.endBeforeSpawn('CANCELLED', 'cancelled before start') : this.endBeforeSpawn('FAILED', prepared.reason);
    if (this.cancelRequested()) return this.endBeforeSpawn('CANCELLED', 'cancelled before start');
    let handle;
    try {
      handle = await this.deps.executor.spawn(row);
    } catch (error) {
      return this.endBeforeSpawn('FAILED', `spawn failed: ${errorMessage(error)}`);
    }
    this.events.transition('RUNNING', undefined, { pid: handle.pid, pgid: handle.pgid, branch: prepared.branch });
    return true;
  }

  private async endBeforeSpawn(to: 'FAILED' | 'CANCELLED', reason: string): Promise<false> {
    this.events.transition(to, reason);
    await this.cleanup();
    return false;
  }

  private async tick(watcher: JobWatcher, final: boolean): Promise<void> {
    try {
      await watcher.tick(final);
    } catch (error) {
      this.tickErrors += 1;
      if (this.tickErrors % TICK_WARN_EVERY === 1) this.events.lifecycle('warn', `watcher error: ${errorMessage(error)}`);
    }
  }

  private escalateKill(row: JobRow): void {
    if (this.cancelSentAtMs === null || this.sigkilled || row.pgid === null) return;
    if (this.deps.now().getTime() - this.cancelSentAtMs < this.deps.tuning.killGraceMs) return;
    this.sigkilled = true;
    this.events.lifecycle('warn', 'process ignored SIGTERM; sending SIGKILL');
    this.deps.executor.kill(row.pgid, 'SIGKILL');
  }

  private async watchUntilExit(resumed: boolean): Promise<void> {
    const start = this.mustRow();
    // BUG-2: a RUNNING row with pid === null is corrupt (journal patch missing or DB race); fall through to
    // finish() would upload a partial bundle and call it FAILED with 'no status.json' — honest, but reachable on
    // a tampered journal. failSafe records a 'runner error: pid missing on RUNNING row' and ends locally.
    if (start.state === 'RUNNING' && start.pid === null) {
      await this.failSafe(new Error('pid missing on RUNNING row'));
      return;
    }
    const watcher = this.deps.executor.createWatcher(start, this.events, {
      startAtEnd: resumed,
      onRunIds: (ids) => { this.deps.journal.updateJob(this.jobId, this.leaseEpoch, { naxRunId: ids.naxRunId, logPath: ids.logPath }); },
    });
    if (start.cancelRequestedAt !== null && start.state === 'RUNNING') this.sendTerm(start);
    for (;;) {
      await this.tick(watcher, false);
      if (this.halted) return;
      const row = this.mustRow();
      if (row.pid === null || !this.deps.executor.isAlive(row.pid)) break;
      this.escalateKill(row);
      await this.deps.sleep(this.deps.tuning.statusPollMs);
      if (this.halted) return;
    }
    await this.tick(watcher, true);
    await this.reapQuietly(this.mustRow());
  }

  private async judge(row: JobRow): Promise<{ verdict: Verdict; snapshot: SnapshotEventPayload }> {
    const cancelled = row.cancelRequestedAt !== null;
    if (row.command === 'PLAN') {
      const check = await this.deps.executor.readPlan(row);
      return { verdict: planVerdict({ cancelRequested: cancelled, check }), snapshot: {} };
    }
    const status = await this.deps.executor.readStatus(row);
    return { verdict: runVerdict({ cancelRequested: cancelled, status }), snapshot: status ? mapStatusToSnapshot(status) : {} };
  }

  private async finish(): Promise<void> {
    const row = this.mustRow();
    if (isTerminalState(row.state)) {
      await this.cleanup();
      return;
    }
    const judged = await this.judge(row);
    let verdict = judged.verdict;
    let result = { branch: row.resultBranch, sha: row.resultSha };
    if (row.command === 'PLAN' && verdict.state === 'COMPLETED' && row.resultSha === null) {
      const pushed = await this.deps.executor.finishPlan(row);
      if (pushed.ok) {
        result = { branch: pushed.branch, sha: pushed.sha };
        this.deps.journal.updateJob(this.jobId, this.leaseEpoch, { resultBranch: pushed.branch, resultSha: pushed.sha });
      } else {
        verdict = { state: 'FAILED', reason: pushed.reason };
      }
    } else if (row.command === 'RUN') {
      const ledger = await this.deps.executor.readFinishLedger(row);
      if (ledger) result = { branch: ledger.branch, sha: ledger.headSha };
    }
    if (this.halted) return;
    if (this.events.currentState() === 'RUNNING') this.events.transition('UPLOADING');
    if (!(await this.waitUntil(() => !this.uploadingPending())) && !this.halted) {
      this.events.lifecycle('warn', 'UPLOADING event not acked in time; uploading anyway');
    }
    if (this.halted) return;
    const outcome = await this.uploadWithConflictRetry(row);
    if (this.halted) return;
    if (outcome.kind === 'stale') {
      this.deps.log.warn('bundle upload fenced (stale lease); waiting for ABANDON', { jobId: this.jobId, leaseEpoch: this.leaseEpoch });
      return;
    }
    if (outcome.kind === 'state-conflict') {
      // D60: the server will not take this job's bundle at this epoch and sends no ABANDON. It owns the job's state; report nothing more.
      this.events.lifecycle('error', `bundle upload refused twice (${outcome.detail}); ending the job locally, the server owns its state`);
      await this.cleanup();
      return;
    }
    const snapshot: SnapshotEventPayload = {
      ...judged.snapshot, ...(result.branch ? { resultBranch: result.branch } : {}), ...(result.sha ? { resultSha: result.sha } : {}),
    };
    if (Object.keys(snapshot).length > 0) this.events.snapshot(snapshot);
    this.events.transition(verdict.state, terminalReason(verdict, outcome));
    await this.cleanup();
  }

  /** D60: true when the journal holds no unacked UPLOADING state event (the server has applied it). */
  private uploadingPending(): boolean {
    return this.deps.journal.pendingEvents(this.jobId, this.leaseEpoch, PENDING_SCAN_LIMIT)
      .some((event) => event.type === 'state' && (event.payload as StateEventPayload).to === 'UPLOADING');
  }

  private hasPendingEvents(): boolean {
    return this.deps.journal.pendingEvents(this.jobId, this.leaseEpoch, 1).length > 0;
  }

  /** Bounded wait on the injected clock. `uploadAckWaitMs <= 0` waits for nothing and reports success. */
  private async waitUntil(done: () => boolean): Promise<boolean> {
    const { uploadAckWaitMs, ackPollMs } = this.deps.tuning;
    if (uploadAckWaitMs <= 0) return true;
    const deadline = this.deps.now().getTime() + uploadAckWaitMs;
    while (!done()) {
      if (this.halted || this.deps.now().getTime() >= deadline) return false;
      await this.deps.sleep(ackPollMs);
    }
    return true;
  }

  /** D60: a 409 that says "wrong job state" may just mean the server has not applied our events yet: retry once after they are acked. */
  private async uploadWithConflictRetry(row: JobRow): Promise<UploadOutcome> {
    const first = await this.uploadBundle(row);
    if (first.kind !== 'state-conflict') return first;
    this.events.lifecycle('warn', `bundle upload refused (${first.detail}); retrying after the next ack`);
    await this.waitUntil(() => !this.hasPendingEvents());
    return this.halted ? first : this.uploadBundle(row);
  }

  private async uploadBundle(row: JobRow): Promise<UploadOutcome> {
    let file: BundleFile;
    try {
      file = await this.deps.executor.collectBundle(row);
    } catch (error) {
      this.deps.log.error('bundle build failed', { jobId: this.jobId, error: errorMessage(error) });
      return { kind: 'failed', detail: `bundle build failed: ${errorMessage(error)}` };
    }
    if (file.skipped && file.skipped.length > 0) {
      this.events.lifecycle('warn', `bundle left out ${file.skipped.length} file(s) whose names have a newline or backslash`, file.skipped.slice(0, 3));
    }
    return this.deps.uploader.upload(row, file, () => this.deps.executor.collectBundle(row));
  }

  private async cleanup(): Promise<void> {
    const row = this.row();
    if (!row) return;
    try {
      await this.deps.executor.cleanup(row);
    } catch (error) {
      this.deps.log.warn('cleanup failed', { jobId: this.jobId, error: errorMessage(error) });
    }
    this.deps.journal.markDone(this.jobId, this.leaseEpoch);
  }

  /** A runner error must still end the job with a legal transition: RUNNING has no direct way to FAILED. */
  private async failSafe(error: unknown): Promise<void> {
    if (this.halted) return;
    this.deps.log.error('job run failed', { jobId: this.jobId, error: errorMessage(error) });
    try {
      // D65: a nax that is still running must not outlive the job's terminal report (the repo mutex is about to be released).
      const row = this.row();
      if (row) {
        await killIfOurs(this.deps.executor, row, this.deps.log);
        // BUG-4: when the run never spawned (pid is null), a stale `.nax-pids` from a previous attempt at this
        // jobDir would still be inside `since = createdAt`, so reap could SIGKILL someone else's pid. Skip it.
        if (row.pid !== null) await this.reapQuietly(row);
      }
      if (this.events.currentState() === 'RUNNING') this.events.transition('UPLOADING');
      this.events.transition('FAILED', `runner error: ${errorMessage(error)}`);
      await this.cleanup();
    } catch (inner) {
      this.deps.log.error('job failure could not be recorded', { jobId: this.jobId, error: errorMessage(inner) });
    }
  }
}

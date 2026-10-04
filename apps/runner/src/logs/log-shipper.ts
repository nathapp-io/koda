import { errorMessage } from '../errors';
import type { Logger } from '../logger';
import { backoffDelay } from '../sync/backoff';
import type { Sleep } from '../time';
import { findRunLog } from '../watcher/run-log';
import { classifyAnswer, type AnswerAction } from './answer';
import { readWindow } from './read-window';
import type { DrainResult, LogJob, LogShipping, LogStreamName, LogTransport, PutLogAnswer } from './types';

export interface LogShipperTuning {
  readonly chunkBytes: number;
  readonly maxInFlight: number;
  readonly putTimeoutMs: number;
  readonly backoffMaxMs: number;
}

export interface LogShipperDeps {
  readonly transport: LogTransport;
  readonly log: Logger;
  readonly nowMs: () => number;
  readonly sleep: Sleep;
  readonly random: () => number;
  readonly tuning: LogShipperTuning;
}

type StreamStatus = 'active' | 'done' | 'stopped' | 'diverged';

interface StreamEntry {
  readonly job: JobEntry;
  readonly stream: LogStreamName;
  readonly path: string;
  acked: number;
  status: StreamStatus;
  /** Plan D324: may have bytes to send. Cleared when picked; set by wake, drain, an ack, a backoff or a pause. */
  dirty: boolean;
  busy: boolean;
  failures: number;
  retryAt: number;
  inFlight: AbortController | null;
}

interface JobEntry {
  readonly key: string;
  readonly spec: LogJob;
  readonly streams: StreamEntry[];
  draining: boolean;
  /** Look for the run log on the next worker pass. */
  runSearch: boolean;
  /** A drain may finish: the run stream exists, is not expected, or was searched for after the drain began. */
  runResolved: boolean;
  waiters: Array<(result: DrainResult) => void>;
  drainTimer: AbortController | null;
}

type PutResult = { readonly kind: 'answer'; readonly answer: PutLogAnswer } | { readonly kind: 'error'; readonly message: string };

interface SentWindow {
  readonly fileSize: number;
  readonly sentFrom: number;
  readonly sentBytes: number;
  readonly final: boolean;
}

const IDLE_MS = 60_000;
const ERROR_PAUSE_MS = 1_000;
const jobKey = (jobId: string, leaseEpoch: number): string => `${jobId}:${leaseEpoch}`;

/**
 * S2a §2.4: one shipper for the whole runner (R4). Workers PUT raw byte windows of each job's log files to the
 * upload route, at most `maxInFlight` at a time, round-robin over the streams (plan D324).
 */
export class LogShipper implements LogShipping {
  private readonly jobs = new Map<string, JobEntry>();
  private order: StreamEntry[] = [];
  private cursor = -1;
  private pausedUntil = 0;
  private wakeSignal = new AbortController();
  private workers: Array<Promise<void>> = [];
  private closed = false;

  constructor(private readonly deps: LogShipperDeps) {}

  register(spec: LogJob): void {
    const key = jobKey(spec.jobId, spec.leaseEpoch);
    if (this.closed || this.jobs.has(key)) return;
    const job: JobEntry = {
      key, spec, streams: [], draining: false, runSearch: spec.sources.runLog, runResolved: !spec.sources.runLog, waiters: [], drainTimer: null,
    };
    this.jobs.set(key, job);
    this.addStream(job, 'stdout', spec.sources.stdoutPath);
    this.addStream(job, 'stderr', spec.sources.stderrPath);
    this.startWorkers();
    this.kick();
  }

  wake(jobId: string, leaseEpoch: number): void {
    const job = this.jobs.get(jobKey(jobId, leaseEpoch));
    if (!job) return;
    for (const stream of job.streams) stream.dirty = true;
    if (this.lacksRun(job)) job.runSearch = true;
    this.kick();
  }

  drain(jobId: string, leaseEpoch: number, timeoutMs: number): Promise<DrainResult> {
    const job = this.jobs.get(jobKey(jobId, leaseEpoch));
    if (!job) return Promise.resolve('drained');
    const result = new Promise<DrainResult>((resolve) => { job.waiters = [...job.waiters, resolve]; });
    job.draining = true;
    if (this.lacksRun(job)) {
      job.runSearch = true;
      job.runResolved = false;
    }
    for (const stream of job.streams) stream.dirty = true;
    if (job.drainTimer === null) {
      const timer = new AbortController();
      job.drainTimer = timer;
      void this.deps.sleep(timeoutMs, timer.signal).then(() => {
        if (!timer.signal.aborted) this.endJob(job, 'timeout');
      });
    }
    this.checkDrained(job);
    this.kick();
    return result;
  }

  stopJob(jobId: string, leaseEpoch: number): void {
    const job = this.jobs.get(jobKey(jobId, leaseEpoch));
    if (job) this.endJob(job, 'stopped');
  }

  /** Plan D328: daemon stop and crash. Pending drains resolve 'stopped'; in-flight PUTs are aborted. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const job of [...this.jobs.values()]) this.endJob(job, 'stopped');
    this.kick();
    await Promise.allSettled(this.workers);
  }

  private lacksRun(job: JobEntry): boolean {
    return job.spec.sources.runLog && !job.streams.some((s) => s.stream === 'run');
  }

  private addStream(job: JobEntry, stream: LogStreamName, path: string): void {
    const entry: StreamEntry = { job, stream, path, acked: 0, status: 'active', dirty: true, busy: false, failures: 0, retryAt: 0, inFlight: null };
    job.streams.push(entry);
    this.order = [...this.order, entry];
  }

  private startWorkers(): void {
    if (this.workers.length > 0) return;
    this.workers = Array.from({ length: this.deps.tuning.maxInFlight }, () => this.work());
  }

  /** Wakes every idle worker: the current sleep's signal aborts and a fresh one takes its place. */
  private kick(): void {
    const previous = this.wakeSignal;
    this.wakeSignal = new AbortController();
    previous.abort();
  }

  private async work(): Promise<void> {
    while (!this.closed) {
      // Final review: the signal is taken BEFORE any await, so a kick() during discover() or ship() is never lost.
      const signal = this.wakeSignal.signal;
      try {
        await this.discover();
        const now = this.deps.nowMs();   // one clock read for pick and idleMs, so a due retry is never slept past
        const next = this.pick(now);
        if (next) await this.ship(next);
        else if (this.closed || [...this.jobs.values()].some((job) => job.runSearch)) continue;
        else await this.deps.sleep(this.idleMs(now), signal);
      } catch (error) {
        this.deps.log.warn('log shipper error', { error: errorMessage(error) });
        if (!this.closed) await this.deps.sleep(ERROR_PAUSE_MS, signal);
      }
    }
  }

  /** The run log appears once nax starts its run (spec §2.4); a drain searches once more before it can finish. */
  private async discover(): Promise<void> {
    for (const job of [...this.jobs.values()]) {
      if (!job.runSearch) continue;
      job.runSearch = false;
      const searchedWhileDraining = job.draining;
      let path: string | null;
      try {
        path = await findRunLog(job.spec.sources.outDir, job.spec.sources.feature);
      } catch (error) {
        job.runSearch = true;   // a file vanished mid-search: look again (work() paces a repeated throw at 1 s)
        throw error;
      }
      if (this.jobs.get(job.key) !== job) continue;
      if (path !== null && this.lacksRun(job)) this.addStream(job, 'run', path);
      if (path !== null || searchedWhileDraining) job.runResolved = true;
      this.checkDrained(job);
    }
  }

  private pick(now: number): StreamEntry | null {
    if (now < this.pausedUntil || this.order.length === 0) return null;
    for (let step = 1; step <= this.order.length; step += 1) {
      const index = (this.cursor + step) % this.order.length;
      const entry = this.order[index];
      if (entry.status !== 'active' || entry.busy || !entry.dirty || entry.retryAt > now) continue;
      this.cursor = index;
      entry.busy = true;
      entry.dirty = false;
      return entry;
    }
    return null;
  }

  private idleMs(now: number): number {
    const waits = [this.pausedUntil - now, ...this.order.filter((s) => s.status === 'active' && !s.busy && s.dirty).map((s) => s.retryAt - now)]
      .filter((ms) => ms > 0);
    return waits.length > 0 ? Math.min(...waits) : IDLE_MS;
  }

  private async ship(entry: StreamEntry): Promise<void> {
    try {
      const window = await readWindow(entry.path, entry.acked, this.deps.tuning.chunkBytes, entry.job.draining);
      if (entry.status !== 'active') return;
      if (window === null) {
        if (entry.job.draining) this.settle(entry, 'done');   // plan D325: no file, nothing to complete
        return;
      }
      if (window.fileSize < entry.acked) {
        this.diverge(entry, `the ${entry.stream} log shrank below what the server holds (${window.fileSize} < ${entry.acked} bytes); the bundle fills it`);
        return;
      }
      const final = entry.job.draining && entry.acked + window.bytes.length >= window.fileSize;
      if (window.bytes.length === 0 && !final) return;
      const sentFrom = entry.acked;
      const result = await this.put(entry, window.bytes, final);
      if (entry.status !== 'active') return;
      this.apply(entry, result, { fileSize: window.fileSize, sentFrom, sentBytes: window.bytes.length, final });
    } catch (error) {
      // Final review: a read error (EACCES, a file replaced mid-read) or a throwing callback must not strand the
      // stream with dirty=false; it backs off and is retried, so a drain still converges or times out cleanly.
      if (entry.status === 'active') this.backoff(entry, errorMessage(error));
    } finally {
      entry.busy = false;
      entry.inFlight = null;
    }
  }

  private async put(entry: StreamEntry, bytes: Buffer, final: boolean): Promise<PutResult> {
    const request = new AbortController();
    const timer = new AbortController();
    entry.inFlight = request;
    void this.deps.sleep(this.deps.tuning.putTimeoutMs, timer.signal).then(() => {
      if (!timer.signal.aborted) request.abort(new Error('log upload timed out'));
    });
    try {
      const { jobId, leaseEpoch } = entry.job.spec;
      const answer = await this.deps.transport.putLog({ jobId, stream: entry.stream, leaseEpoch, offset: entry.acked, bytes, final, signal: request.signal });
      return { kind: 'answer', answer };
    } catch (error) {
      return { kind: 'error', message: errorMessage(error) };
    } finally {
      timer.abort();
    }
  }

  private apply(entry: StreamEntry, result: PutResult, sent: SentWindow): void {
    const action: AnswerAction = result.kind === 'answer' ? classifyAnswer(result.answer) : { kind: 'backoff', detail: result.message };
    const { jobId, leaseEpoch } = entry.job.spec;
    switch (action.kind) {
      case 'ack':
        if (action.size > sent.fileSize) {
          this.diverge(entry, `the server holds more of the ${entry.stream} log than the file (${action.size} > ${sent.fileSize} bytes); the bundle fills it`);
          return;
        }
        if (action.size <= sent.sentFrom && sent.sentBytes > 0 && !sent.final && action.size === entry.acked) {
          this.backoff(entry, `no progress: the server answered size ${action.size} for bytes at ${sent.sentFrom}`);
          return;
        }
        entry.acked = action.size;
        entry.failures = 0;
        entry.dirty = true;
        return;
      case 'done':
        entry.acked = action.size;
        this.settle(entry, 'done');
        return;
      case 'cap':
        this.notify(entry, 'warn', `the ${entry.stream} log reached the server's size cap at ${action.size} bytes; the full text is in the bundle`);
        this.settle(entry, 'stopped');
        return;
      case 'pause':
        this.pausedUntil = Math.max(this.pausedUntil, this.deps.nowMs() + action.ms);
        entry.failures = 0;
        entry.dirty = true;
        return;
      case 'stop-job':
        this.deps.log.warn('log upload refused for the job; its streams stop', { jobId, leaseEpoch, status: action.status });
        this.endJob(entry.job, 'stopped');
        return;
      case 'fail-stream':
        this.notify(entry, 'error', `${entry.stream} log upload refused (HTTP ${action.status}); the bundle fills it`);
        this.settle(entry, 'stopped');
        return;
      case 'backoff':
        this.backoff(entry, action.detail);
        return;
    }
  }

  private backoff(entry: StreamEntry, detail: string): void {
    const { jobId, leaseEpoch } = entry.job.spec;
    entry.failures += 1;
    entry.retryAt = this.deps.nowMs() + backoffDelay(entry.failures - 1, this.deps.random, this.deps.tuning.backoffMaxMs);
    entry.dirty = true;
    if (entry.failures === 1 || entry.failures % 10 === 0) {
      this.deps.log.warn('log upload failed; backing off', { jobId, leaseEpoch, stream: entry.stream, failures: entry.failures, detail });
    }
  }

  /** A lifecycle callback that throws must not skip the state change that follows it. */
  private notify(entry: StreamEntry, level: 'info' | 'warn' | 'error', message: string): void {
    try {
      entry.job.spec.lifecycle(level, message);
    } catch (error) {
      this.deps.log.warn('log lifecycle callback failed', { jobId: entry.job.spec.jobId, error: errorMessage(error) });
    }
  }

  private diverge(entry: StreamEntry, message: string): void {
    this.notify(entry, 'warn', message);
    this.settle(entry, 'diverged');
  }

  private settle(entry: StreamEntry, status: StreamStatus): void {
    entry.status = status;
    this.checkDrained(entry.job);
  }

  private checkDrained(job: JobEntry): void {
    if (!job.draining || !job.runResolved || job.streams.some((s) => s.status === 'active')) return;
    this.endJob(job, 'drained');
  }

  private endJob(job: JobEntry, result: DrainResult): void {
    if (this.jobs.get(job.key) !== job) return;
    this.jobs.delete(job.key);
    for (const stream of job.streams) {
      if (stream.status === 'active') stream.status = 'stopped';
      stream.inFlight?.abort(new Error('log stream stopped'));
    }
    this.order = this.order.filter((s) => s.job !== job);
    job.drainTimer?.abort();
    const waiters = job.waiters;
    job.waiters = [];
    for (const resolve of waiters) resolve(result);
  }
}

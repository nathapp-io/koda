import type { DrainResult, LogJob, LogShipping } from '../../src/logs/types';

/**
 * Records what a JobRun asks of its log shipper. `register`, `drain` and `stopJob` are also written to `shared`
 * (pass `FakeExecutor.calls` to check their order against executor calls). `holdDrain()` keeps drains pending until
 * `releaseDrain()` or `stopJob`.
 */
export class FakeLogShipping implements LogShipping {
  readonly calls: string[] = [];
  readonly jobs: LogJob[] = [];
  wakes = 0;
  drainResult: DrainResult = 'drained';
  private held: Array<(result: DrainResult) => void> | null = null;

  constructor(private readonly shared?: string[]) {}

  private note(entry: string): void {
    this.calls.push(entry);
    this.shared?.push(entry);
  }

  register(job: LogJob): void {
    this.jobs.push(job);
    this.note(`logs.register:${job.jobId}`);
  }

  wake(): void {
    this.wakes += 1;
  }

  drain(jobId: string): Promise<DrainResult> {
    this.note(`logs.drain:${jobId}`);
    if (this.held === null) return Promise.resolve(this.drainResult);
    return new Promise<DrainResult>((resolve) => { this.held = [...(this.held ?? []), resolve]; });
  }

  stopJob(jobId: string): void {
    this.note(`logs.stop:${jobId}`);
    const waiting = this.held;
    if (waiting === null) return;
    this.held = [];
    for (const resolve of waiting) resolve('stopped');
  }

  holdDrain(): void {
    this.held = [];
  }

  releaseDrain(result: DrainResult = 'drained'): void {
    const waiting = this.held ?? [];
    this.held = null;
    for (const resolve of waiting) resolve(result);
  }
}

/** For Supervisor and CommandHandler specs, which never look at logs. */
export const NO_LOG_SHIPPING: LogShipping = {
  register: () => undefined,
  wake: () => undefined,
  drain: async () => 'drained',
  stopJob: () => undefined,
};

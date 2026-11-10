import type { JobRow } from '../journal/types';
import type { JobCheck, JobCheckOptions } from './job-check';

/**
 * #406: a job-check call that ran out of time (`NAX_TIMEOUT`) says the host was busy, not that the machine cannot run
 * the job. Every other reason (`project untrusted`, `capability mismatch: ...`, an unparseable answer) is nax's verdict.
 */
export function isTransientJobCheckReason(reason: string): boolean {
  return /\bNAX_TIMEOUT\b/.test(reason);
}

export interface RetryingJobCheckDeps {
  readonly inner: JobCheck;
  /** Attempts after the first; 0 is the inner check alone. */
  readonly retries: number;
  /** The wait before the first retry; it doubles for each one after. */
  readonly backoffMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * #406: asks the inner check again, with backoff, while it answers only with timeouts. The check runs inside the
 * per-repo mutex (D111), so the retries stay few and short; a cancelled job is not asked again. When every attempt
 * times out, the last reason is returned, so it still names `NAX_TIMEOUT`.
 */
export class RetryingJobCheck implements JobCheck {
  constructor(private readonly deps: RetryingJobCheckDeps) {}

  async check(job: JobRow, repoDir: string, options?: JobCheckOptions): Promise<string | null> {
    const { inner, retries, backoffMs, sleep } = this.deps;
    let reason = await inner.check(job, repoDir, options);
    for (let retry = 0; retry < retries; retry += 1) {
      if (reason === null || !isTransientJobCheckReason(reason) || options?.isCancelled?.() === true) return reason;
      await sleep(backoffMs * 2 ** retry);
      if (options?.isCancelled?.() === true) return reason;
      reason = await inner.check(job, repoDir, options);
    }
    return reason;
  }
}

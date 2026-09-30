import { errorMessage } from '../errors';
import type { Logger } from '../logger';
import { NetworkError } from '../sync/http';
import type { Sleep } from '../time';
import type { BundleFile } from './build-bundle';

export type UploadOutcome =
  | { kind: 'ok' }
  | { kind: 'too-large' }
  | { kind: 'stale' }
  | { kind: 'state-conflict'; detail: string }
  | { kind: 'failed'; detail: string };

export interface UploadDeps {
  upload(args: { jobId: string; leaseEpoch: number; file: BundleFile }): Promise<{ status: number; message?: string }>;
  rebuild(): Promise<BundleFile>;
  readonly sleep: Sleep;
  readonly log: Logger;
}

export const UPLOAD_ATTEMPTS = 3;
export const LARGE_BUNDLE_BYTES = 100 * 1024 * 1024;
const BACKOFF_MS = [1_000, 3_000];
const JOB_STATE_MESSAGE = /^The job is \S+; this action is not allowed/i;

/**
 * D60: the server answers 409 for a lost lease (`fleet.fence`, ABANDON queued) and for a job that is not RUNNING or
 * UPLOADING at this epoch (`fleet.jobState`, no ABANDON). Only the translated message tells them apart (the runner asks
 * for English); anything unrecognised is `stale`, the safe reading (park until the server says ABANDON).
 */
export function classifyConflict(message: string | undefined): 'stale' | 'state-conflict' {
  return message !== undefined && JOB_STATE_MESSAGE.test(message) ? 'state-conflict' : 'stale';
}

/** Design §2 step 9; the outcome decides the terminal state (D36, D60, D68). */
export async function uploadWithRetry(deps: UploadDeps, jobId: string, leaseEpoch: number, first: BundleFile): Promise<UploadOutcome> {
  let file = first;
  let rebuilt = false;
  let attempt = 1;
  // BUG-6: the old code conflated `NetworkError` (timeout / DNS) and 5xx under one counter, and the
  // `too-large` branch was unreachable because `status === 0` never reached it (a non-OK response always
  // surfaces as a `ServerError` from the client). Now `NetworkError` is counted separately so the
  // proxy-silently-drops-large-bundle intent (D68) is enforced only on `NetworkError` exhaustion;
  // 5xx always stays `failed`.
  let networkFailures = 0;
  for (;;) {
    let status = 0;
    let message: string | undefined;
    try {
      ({ status, message } = await deps.upload({ jobId, leaseEpoch, file }));
    } catch (error) {
      if (!(error instanceof NetworkError)) return { kind: 'failed', detail: errorMessage(error) };
      networkFailures += 1;
    }
    if (status >= 200 && status < 300) return { kind: 'ok' };
    if (status === 413) return { kind: 'too-large' };
    if (status === 409) {
      return classifyConflict(message) === 'stale' ? { kind: 'stale' } : { kind: 'state-conflict', detail: message ?? 'job state conflict' };
    }
    if (status === 422) {
      if (rebuilt) return { kind: 'failed', detail: 'HTTP 422' };
      rebuilt = true;
      try {
        file = await deps.rebuild();
      } catch (error) {
        return { kind: 'failed', detail: `rebuild failed: ${errorMessage(error)}` };
      }
      continue;
    }
    if (status !== 0 && status < 500) return { kind: 'failed', detail: `HTTP ${status}` };
    deps.log.warn('bundle upload attempt failed', { jobId, attempt, status });
    if (attempt >= UPLOAD_ATTEMPTS) {
      if (networkFailures >= UPLOAD_ATTEMPTS && file.size > LARGE_BUNDLE_BYTES) return { kind: 'too-large' };
      return { kind: 'failed', detail: status === 0 ? 'network error' : `HTTP ${status}` };
    }
    await deps.sleep(BACKOFF_MS[attempt - 1] ?? 3_000);
    attempt += 1;
  }
}

import type { Now, Sleep } from '../time';

/** S3 §3: a config job has no status.json, so the run itself stamps `heartbeatAt` (dashboard `job_silent`, silence sweep). */
export const CONFIG_HEARTBEAT_MS = 30_000;

/** Returns the stop function; the abort also cuts the pending sleep short (systemSleep honours the signal). */
export function startHeartbeat(input: { everyMs: number; sleep: Sleep; now: Now; emit: (heartbeatAt: string) => void }): () => void {
  const abort = new AbortController();
  void (async () => {
    for (;;) {
      await input.sleep(input.everyMs, abort.signal);
      if (abort.signal.aborted) return;
      input.emit(input.now().toISOString());
    }
  })();
  return () => abort.abort();
}

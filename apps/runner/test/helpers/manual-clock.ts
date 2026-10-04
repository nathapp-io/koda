import type { Sleep } from '../../src/time';

/** A clock that moves only when the test says so. A sleeper wakes when `advance` reaches its deadline, or at once on abort. */
export function manualClock(startMs = 0) {
  let t = startMs;
  let sleepers: Array<{ at: number; wake: () => void }> = [];
  const sleep: Sleep = (ms, signal) => new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const entry = { at: t + ms, wake: () => { signal?.removeEventListener('abort', onAbort); resolve(); } };
    const onAbort = (): void => {
      sleepers = sleepers.filter((s) => s !== entry);
      resolve();
    };
    sleepers = [...sleepers, entry];
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  return {
    nowMs: (): number => t,
    sleep,
    /** Moves time forward and wakes every sleeper that is due. Callers then `waitFor` what the woken code does. */
    advance(ms: number): void {
      t += ms;
      const due = sleepers.filter((s) => s.at <= t);
      sleepers = sleepers.filter((s) => s.at > t);
      for (const s of due) s.wake();
    },
  };
}

import { readCapped } from '../../nax/nax-cli';
import { signalGroup } from '../nax-process';
import type { ProcOptions, ProcResult } from './types';

/** Bounds a runaway; nax generate / lint / gh print kilobytes. */
export const OUTPUT_CAP_BYTES = 262_144;
export const STOP_POLL_MS = 200;
export const KILL_GRACE_MS = 5_000;

export interface TrackedRunOptions extends ProcOptions {
  readonly nowMs: () => number;
  readonly isStopped: () => boolean;
  /** D484: the caller journals the pid and pgid while the call runs, and clears them with `null` after. */
  readonly onProcess: (proc: { pid: number; pgid: number } | null) => void;
  readonly killGraceMs?: number;
}

/**
 * D484: detached, so the child leads its own session and process group (pgid = pid, as `spawnNax`) and a stop, the
 * deadline or the existing cancel path (SIGTERM to the journaled pgid) reaches its grandchildren too (the gh shim and
 * gh). SIGTERM first, SIGKILL after the grace.
 */
export async function trackedRun(argv: readonly string[], options: TrackedRunOptions): Promise<ProcResult> {
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  try {
    proc = Bun.spawn([...argv], { cwd: options.cwd, env: { ...options.env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true });
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code ?? 'SPAWN_FAILED';
    return { code: 127, stdout: '', stderr: `${argv[0] ?? 'command'}: cannot start (${errno})`, timedOut: false, stopped: false, spawnError: errno };
  }
  const pgid = proc.pid;
  options.onProcess({ pid: proc.pid, pgid });
  const grace = options.killGraceMs ?? KILL_GRACE_MS;
  let done = false;
  let stopped = false;
  let timedOut = false;
  let termAt: number | null = null;
  void (async () => {
    while (!done) {
      await Bun.sleep(STOP_POLL_MS);
      if (done) return;
      const now = options.nowMs();
      if (termAt === null) {
        if (options.isStopped()) stopped = true;
        else if (now >= options.deadlineMs) timedOut = true;
        else continue;
        signalGroup(pgid, 'SIGTERM');
        termAt = now;
      } else if (now - termAt >= grace) {
        signalGroup(pgid, 'SIGKILL');
        return;
      }
    }
  })();
  try {
    const [stdout, stderr, code] = await Promise.all([readCapped(proc.stdout, OUTPUT_CAP_BYTES), readCapped(proc.stderr, OUTPUT_CAP_BYTES), proc.exited]);
    // A stop whose SIGTERM came from outside this watcher (the supervisor's CANCEL) can end the call between two
    // polls: the child died of the signal while a stop was requested, so the exit code is not a verdict (D484).
    if (!stopped && options.isStopped()) stopped = true;
    return { code, stdout: stdout.text, stderr: stderr.text, timedOut, stopped };
  } finally {
    done = true;   // the watcher never signals after this: the pgid may be reused
    options.onProcess(null);
  }
}

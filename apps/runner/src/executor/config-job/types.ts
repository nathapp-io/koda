/** One finished nax / gh / glab call of a config job (D484). */
export interface ProcResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The job's deadline ended the call. */
  readonly timedOut: boolean;
  /** A cancel or halt ended the call. */
  readonly stopped: boolean;
  /** The executable could not be started at all. */
  readonly spawnError?: string;
}

export interface ProcOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Absolute, on the job's clock: the config job's hard timeout (spec §5 lifecycle). */
  readonly deadlineMs: number;
}

export type RunProc = (argv: readonly string[], options: ProcOptions) => Promise<ProcResult>;

export interface StepClock {
  readonly nowMs: () => number;
  readonly deadlineMs: number;
  /** A cancel was requested or the run was halted (ABANDON, daemon stop). */
  readonly isStopped: () => boolean;
}

export class StoppedError extends Error {
  constructor() {
    super('config job stopped');
    this.name = 'StoppedError';
  }
}

export class DeadlineError extends Error {
  constructor() {
    super('config job timed out');
    this.name = 'DeadlineError';
  }
}

/** Called between steps: a stop wins over the deadline. */
export function checkpoint(clock: StepClock): void {
  if (clock.isStopped()) throw new StoppedError();
  if (clock.nowMs() >= clock.deadlineMs) throw new DeadlineError();
}

/** The timeout a git call gets: what is left of the job's budget, never 0 (0 would mean "no timeout" to some callers). */
export function remainingMs(clock: StepClock): number {
  return Math.max(1, clock.deadlineMs - clock.nowMs());
}

export function raiseIfInterrupted(result: ProcResult): void {
  if (result.stopped) throw new StoppedError();
  if (result.timedOut) throw new DeadlineError();
}

import type { AssignPayload } from '@nathapp/fleet-protocol';
import { PathError, assertFeature, assertRelativePath } from '../paths/safe-segment';
import { jobProfileName } from './job-profile';

/** Same rule as the server's profile names (apps/api/src/fleet/common/capabilities.ts PROFILE_NAME_RE). */
export const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const COST_RE = /^\d+(\.\d{1,4})?$/;
export const RESERVED_PREFIX = 'koda-job-';

/** S1 spec §5.2 step 4. Every dynamic piece is checked again here (D30): the chain is joined with commas. */
export function buildNaxArgv(naxCommand: readonly string[], assign: AssignPayload): string[] {
  const feature = assertFeature(assign.feature);
  for (const profile of assign.profiles) {
    if (!PROFILE_NAME.test(profile) || profile.startsWith(RESERVED_PREFIX)) throw new PathError('invalid profile');
  }
  const chain = [...assign.profiles, jobProfileName(assign.jobId)].join(',');
  if (assign.command === 'PLAN') {
    return [...naxCommand, 'plan', '--from', assertRelativePath('planFrom', assign.planFrom), '-f', feature, '--profile', chain];
  }
  if (!COST_RE.test(assign.maxCostUsd)) throw new PathError('invalid maxCostUsd');
  return [...naxCommand, 'run', '--headless', '--json', '-f', feature, '--profile', chain, '--max-cost', assign.maxCostUsd];
}

export interface SpawnNaxOptions {
  readonly cwd: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly env: Record<string, string | undefined>;
}

/**
 * Detached: its own session and process group on macOS and Linux, so it survives a daemon restart; output goes to
 * files (a pipe would die with the daemon). pgid equals pid for a new session leader.
 */
export function spawnNax(argv: readonly string[], options: SpawnNaxOptions): { pid: number; pgid: number } {
  const proc = Bun.spawn([...argv], {
    cwd: options.cwd, env: options.env, stdin: 'ignore', detached: true,
    stdout: Bun.file(options.stdoutPath), stderr: Bun.file(options.stderrPath),
  });
  proc.unref();
  return { pid: proc.pid, pgid: proc.pid };
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Never signals pgid 0, 1, a negative or a non-integer: `kill(-1)` would signal every process we may signal. */
export function signalGroup(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

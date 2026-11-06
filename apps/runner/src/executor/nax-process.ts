import type { AssignPayload } from '@nathapp/fleet-protocol';
import { PathError, assertFeature, assertRelativePath } from '../paths/safe-segment';
import { jobProfileName } from './job-profile';

/** Same rule as the server's profile names (apps/api/src/fleet/common/capabilities.ts PROFILE_NAME_RE). */
export const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const COST_RE = /^\d+(\.\d{1,4})?$/;
export const RESERVED_PREFIX = 'koda-job-';
/** fleet-agent-job US-008: `nax agents run` has no cost cap, so every AGENT run is bounded by a timeout instead. */
export const AGENT_DEFAULT_TIMEOUT_SEC = 3_600;

function reviewPrNumber(assign: AssignPayload): number {
  if (!assign.review || !Number.isSafeInteger(assign.review.prNumber) || assign.review.prNumber <= 0 || !/^[A-Za-z0-9][A-Za-z0-9-]*\[bot\]$/.test(assign.review.botLogin)) throw new PathError('invalid review');
  return assign.review.prNumber;
}

/** S1 spec §5.2 step 4. Every dynamic piece is checked again here (D30): the chain is joined with commas. */
export function buildNaxArgv(naxCommand: readonly string[], assign: AssignPayload, opts: { decisionsPath?: string; rulingsPath?: string; agentTaskPath?: string } = {}): string[] {
  const feature = assertFeature(assign.feature);
  for (const profile of assign.profiles) {
    if (!PROFILE_NAME.test(profile) || profile.startsWith(RESERVED_PREFIX)) throw new PathError('invalid profile');
  }
  const chain = [...assign.profiles, jobProfileName(assign.jobId)].join(',');
  if (assign.command === 'PLAN') {
    return [...naxCommand, 'plan', '--from', assertRelativePath('planFrom', assign.planFrom), '-f', feature, '--profile', chain];
  }
  if (assign.command === 'REVIEW' || assign.command === 'FIX') {
    const prNumber = reviewPrNumber(assign);
    return [
      ...naxCommand, 'bot', 'review', String(prNumber),
      ...(assign.command === 'FIX' ? ['--full'] : []), '--profile', chain,
      ...(opts.decisionsPath === undefined ? [] : ['--decisions', opts.decisionsPath]),
      ...(assign.command === 'FIX' && opts.rulingsPath !== undefined ? ['--rulings', opts.rulingsPath] : []),
    ];
  }
  // fleet-agent-job US-008: the AGENT branch precedes the RUN fallback and has no --max-cost (nax `agents run` has no
  // cost cap; a flow checks its cap between jobs). The task travels on the file the runner wrote, never in argv, and
  // every run is bounded by --timeout: the assign's timeoutSec, else nax's own default turn limit.
  if (assign.command === 'AGENT') {
    const agent = assign.agent;
    if (agent === undefined) throw new Error('agent required for AGENT');
    if (opts.agentTaskPath === undefined) throw new Error('agent task file required for AGENT');
    return [
      ...naxCommand, 'agents', 'run', agent.name, '--task-file', opts.agentTaskPath, '--json', '--profile', chain,
      ...(agent.model === undefined ? [] : ['--model', agent.model]),
      '--timeout', String(agent.timeoutSec ?? AGENT_DEFAULT_TIMEOUT_SEC),
    ];
  }
  if (!COST_RE.test(assign.maxCostUsd)) throw new PathError('invalid maxCostUsd');
  return [...naxCommand, 'run', '--headless', '--json', '-f', feature, '--profile', chain, '--max-cost', assign.maxCostUsd];
}

export function buildFixArgv(naxCommand: readonly string[], assign: AssignPayload): string[] {
  for (const profile of assign.profiles) {
    if (!PROFILE_NAME.test(profile) || profile.startsWith(RESERVED_PREFIX)) throw new PathError('invalid profile');
  }
  if (assign.command !== 'FIX') throw new PathError('invalid review');
  const prNumber = reviewPrNumber(assign);
  const chain = [...assign.profiles, jobProfileName(assign.jobId)].join(',');
  return [...naxCommand, 'bot', 'fix', String(prNumber), '--no-rereview', '--profile', chain, ...(assign.review?.trustDetectedChecks === true ? ['--trust'] : [])];
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

export function isProcessAlive(pid: number, kill: (pid: number, signal: 0) => void = process.kill): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
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

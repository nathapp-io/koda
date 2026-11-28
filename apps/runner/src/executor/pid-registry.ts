import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { errorMessage, firstLine } from '../errors';

export interface PidEntry {
  readonly pid: number;
  readonly spawnedAt: string;
  readonly workdir: string;
}

/** `.nax-pids` is JSON lines (nax src/execution/pid-registry.ts). */
export function parsePidEntries(text: string): PidEntry[] {
  const entries: PidEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (typeof value['pid'] === 'number' && typeof value['spawnedAt'] === 'string' && typeof value['workdir'] === 'string') {
        entries.push({ pid: value['pid'], spawnedAt: value['spawnedAt'], workdir: value['workdir'] });
      }
    } catch {
      // a damaged line is skipped
    }
  }
  return entries;
}

/**
 * BUG-5: lstart reports the start time to the second; with the etime rounding the comparison was firing on an
 * approximate, then-derived start, and a 1s rounding in either direction could push a real nax outside the slack.
 * The slack is now 5s because lstart has 1s precision while the entry's `spawnedAt` is millisecond-accurate, and a
 * slow `Date.now()` NTP step between spawn and reap is no longer the dominant source of error.
 */
export const REGISTRATION_SLACK_MS = 5_000;

/** D37: nax itself refuses to signal stale entries because pids recycle; so does the runner. */
export async function selectReapable(
  entries: readonly PidEntry[],
  opts: { repoDir: string; since: Date; startedAt: (pid: number) => Promise<Date | null>; selfPid?: number },
): Promise<number[]> {
  const repo = resolve(opts.repoDir);
  const picked: number[] = [];
  for (const entry of entries) {
    const registered = Date.parse(entry.spawnedAt);
    if (!Number.isInteger(entry.pid) || entry.pid <= 1 || entry.pid === (opts.selfPid ?? process.pid)) continue;
    if (resolve(entry.workdir) !== repo || Number.isNaN(registered) || registered < opts.since.getTime() - 1_000) continue;
    const started = await opts.startedAt(entry.pid);
    if (started && started.getTime() <= registered + REGISTRATION_SLACK_MS) picked.push(entry.pid);
  }
  return picked;
}

/** BUG-5: `ps -o lstart=` returns the actual start timestamp (locale-formatted), immune to `Date.now()` clock drift
 * between registration and reap. BUG-5a: the child `ps` is forced to `TZ=UTC`, so its output must be parsed as UTC
 * too — `Date.parse` without a zone would read the string in the runner's host TZ, shifting the instant by the UTC
 * offset and making the slack check reject a live nax on any non-UTC host. The executor's contract stays a `Date` for
 * a readable start time and `null` otherwise; US-006 keeps the found/absent/indeterminate distinction in the probe. */
export async function readProcessStart(pid: number, deps: ProcessStartProbeDeps = {}): Promise<Date | null> {
  const probe = await probeProcessStart(pid, deps);
  return probe.outcome === 'found' ? probe.startedAt : null;
}

/** One process command: its exit status and both streams. */
export interface PsRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one process command; rejects when the command cannot be launched or inspected at all. */
export type PsRunner = (argv: readonly string[]) => Promise<PsRunResult>;

/** `LC_ALL=C` and `TZ=UTC` for the same reason as BUG-5a: the start time is compared as UTC, never in the host TZ. */
const runPsCommand: PsRunner = async (argv) => {
  const proc = Bun.spawn([...argv], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode: await proc.exited, stdout, stderr };
};

/**
 * US-006: what one identity probe established about a pid. `absent` is a positive finding — the kernel has no such
 * pid — and only it licenses forgetting an ownership row; `indeterminate` means the probe learned nothing, so the row
 * must stay for a later pass.
 */
export type ProcessStartProbe =
  | { readonly outcome: 'found'; readonly startedAt: Date }
  | { readonly outcome: 'absent' }
  | { readonly outcome: 'indeterminate'; readonly reason: string };

export interface ProcessStartProbeDeps {
  readonly run?: PsRunner;
  /** Does the kernel still know this pid? `signal 0` delivers nothing; it throws `ESRCH` when the pid is gone. */
  readonly exists?: (pid: number) => void;
}

const SIGNAL_ZERO = (pid: number): void => { process.kill(pid, 0); };

/** The `errno` of a failed process operation (`ESRCH`, `EPERM`, …), or '' when it carries none. */
function processErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : '';
}

/** A process operation that failed because the kernel has no such pid: the process is definitively gone. */
export function isNoSuchProcess(error: unknown): boolean {
  return processErrorCode(error) === 'ESRCH';
}

/**
 * US-006: the production identity probe. `ps` printing nothing proves nothing by itself — the same empty answer comes
 * from a command that was refused (`Operation not permitted`, exit 126) as from a pid that no longer exists — so
 * absence is decided by the kernel (`signal 0`), and every other unknown answer is `indeterminate`.
 */
export async function probeProcessStart(pid: number, deps: ProcessStartProbeDeps = {}): Promise<ProcessStartProbe> {
  if (!Number.isInteger(pid) || pid <= 0) return { outcome: 'indeterminate', reason: 'invalid pid' };
  const run = deps.run ?? runPsCommand;
  const exists = deps.exists ?? SIGNAL_ZERO;
  let result: PsRunResult;
  try {
    result = await run(['ps', '-o', 'lstart=', '-p', String(pid)]);
  } catch (error) {
    return { outcome: 'indeterminate', reason: `the process command could not run: ${errorMessage(error)}` };
  }
  const text = result.stdout.trim();
  if (text !== '') {
    const stamp = Date.parse(`${text} UTC`);
    return Number.isNaN(stamp)
      ? { outcome: 'indeterminate', reason: `the process command printed an unreadable start time: ${firstLine(text)}` }
      : { outcome: 'found', startedAt: new Date(stamp) };
  }
  const answer = `exit ${result.exitCode}${result.stderr.trim() === '' ? '' : `, ${firstLine(result.stderr)}`}`;
  try {
    exists(pid);
  } catch (error) {
    return isNoSuchProcess(error)
      ? { outcome: 'absent' }
      : { outcome: 'indeterminate', reason: `the process command printed no start time (${answer}) and the pid is not ours to inspect: ${processErrorCode(error) || errorMessage(error)}` };
  }
  return { outcome: 'indeterminate', reason: `the process command printed no start time (${answer}) for a pid the kernel still knows` };
}

/** The identity check for a process that is not our child: a job's argv carries `koda-job-<jobId>` (S1 spec §5.2 step 4). */
export async function readProcessCommand(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const proc = Bun.spawn(['ps', '-ww', '-o', 'command=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', env: { ...process.env, LC_ALL: 'C' } });
  const text = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return text === '' ? null : text;
}

/** The two process lookups the executor needs; production reads them from `ps`. */
export interface ProcessInfo {
  start(pid: number): Promise<Date | null>;
  command(pid: number): Promise<string | null>;
}

export const PS_PROCESS_INFO: ProcessInfo = { start: readProcessStart, command: readProcessCommand };

export async function reapNaxPids(input: {
  repoDir: string;
  since: Date;
  startedAt?: (pid: number) => Promise<Date | null>;
  kill?: (pid: number) => void;
}): Promise<number[]> {
  const path = join(input.repoDir, '.nax-pids');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const kill = input.kill ?? ((pid: number) => process.kill(pid, 'SIGKILL'));
  const targets = await selectReapable(parsePidEntries(text), { repoDir: input.repoDir, since: input.since, startedAt: input.startedAt ?? readProcessStart });
  const killed: number[] = [];
  for (const pid of targets) {
    try {
      kill(pid);
      killed.push(pid);
    } catch {
      // already gone
    }
  }
  await writeFile(path, '');
  return killed;
}

import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

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
const REGISTRATION_SLACK_MS = 5_000;

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

/** `ps -o etime=` is `[[dd-]hh:]mm:ss` on macOS and Linux; kept for the test surface and for callers that still
 * want elapsed time directly (BUN_TEST_TZ=UTC keeps these deterministic). */
export function parseEtime(text: string): number | null {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!m) return null;
  const [days, hours, minutes, seconds] = [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3]), Number(m[4])];
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

/** BUG-5: `ps -o lstart=` returns the actual start timestamp (locale-formatted), immune to `Date.now()` clock drift
 * between registration and reap. The output is parsed by `Date`, which treats it as local time in the runner's TZ. */
export async function readProcessStart(pid: number): Promise<Date | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  // Force TZ=UTC for `ps` so its locale-formatted output is in the same frame `Date.parse` uses: tests under
  // `bun test` already run with TZ=UTC and `process.env.TZ` may be unset in production, but the daemon's wall
  // clock is the same in either frame. Without the explicit override, `ps` would emit host-local time and the
  // parser would shift it by the host TZ, corrupting the slack check by hours on non-UTC hosts.
  const proc = Bun.spawn(['ps', '-o', 'lstart=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
  const text = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  if (text === '') return null;
  const stamp = Date.parse(text);
  return Number.isNaN(stamp) ? null : new Date(stamp);
}

/** The identity check for a process that is not our child: a job's argv carries `koda-job-<jobId>` (S1 spec §5.2 step 4). */
export async function readProcessCommand(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const proc = Bun.spawn(['ps', '-ww', '-o', 'command=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', env: { ...process.env, LC_ALL: 'C' } });
  const text = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return text === '' ? null : text;
}

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

import { readFile } from 'node:fs/promises';
import { getAgentRuntime, setAgentRuntime, type AgentRuntime } from '@nathapp/nax-agent';
import { errorMessage } from '../errors';
import { isNoSuchProcess, probeProcessStart, REGISTRATION_SLACK_MS, type ProcessStartProbe } from '../executor/pid-registry';
import type { Journal } from '../journal/journal';
import type { OwnedProcessSource } from '../journal/types';
import type { Logger } from '../logger';

/**
 * #518: thread backends start processes that outlive a daemon killed outright. nax-agent spawns native Bash,
 * background commands and git detached (each leads its own process group), the ACP client launches its agent
 * detached, and the service units let those groups survive the daemon (launchd `AbandonProcessGroup`, systemd
 * `KillMode=process`). A thread session never survives a restart, so nothing a previous boot's backends started
 * is wanted by the next one. The ledger records each such process in the journal when it starts and forgets it when
 * it exits; the next daemon to own the home kills what an earlier boot left behind before it accepts any work.
 *
 * nax jobs are not tracked here: the runner spawns nax itself (outside nax-agent's runtime), journals its pgid,
 * and re-adopts or reaps it per job.
 */

type JournalLedger = Pick<Journal, 'recordOwnedProcess' | 'forgetOwnedProcess'>;

export interface OwnedProcessLedgerDeps {
  readonly journal: JournalLedger;
  readonly bootId: string;
  /** `readHostBootId()` at daemon start. */
  readonly hostBoot: string;
  /** Wall-clock ms; compared with `ps lstart`, so production passes `Date.now`, never an injected clock. */
  readonly nowMs: () => number;
  readonly log: Logger;
}

/** What the session factory needs to report an ACP agent's process (its `onProcess` hooks). */
export interface ProcessRecorder {
  spawned(pid: number, how: { group: boolean; source: OwnedProcessSource }): void;
  exited(pid: number): void;
}

export class OwnedProcessLedger implements ProcessRecorder {
  /** pid -> the `spawnedAtMs` of its live row, so an exit forgets exactly the row its spawn wrote. */
  private readonly live = new Map<number, number>();

  constructor(private readonly deps: OwnedProcessLedgerDeps) {}

  /** Never throws: a ledger that cannot write must not stop a backend from running a command. */
  spawned(pid: number, how: { group: boolean; source: OwnedProcessSource }): void {
    if (!Number.isInteger(pid) || pid <= 0) return;
    const spawnedAtMs = this.deps.nowMs();
    try {
      this.deps.journal.recordOwnedProcess({ pid, group: how.group, spawnedAtMs, bootId: this.deps.bootId, hostBoot: this.deps.hostBoot, source: how.source });
      this.live.set(pid, spawnedAtMs);
    } catch (error) {
      this.deps.log.warn('could not record a thread backend process', { pid, error: errorMessage(error) });
    }
  }

  exited(pid: number): void {
    const spawnedAtMs = this.live.get(pid);
    if (spawnedAtMs === undefined) return;
    this.live.delete(pid);
    try {
      this.deps.journal.forgetOwnedProcess(pid, spawnedAtMs);
    } catch (error) {
      // The journal may already be closed while the daemon retires; the next boot's check skips a dead pid.
      this.deps.log.warn('could not forget a thread backend process', { pid, error: errorMessage(error) });
    }
  }
}

/** nax-agent's process-wide runtime slot; injectable so specs never replace the real one. */
export interface AgentRuntimeSlot {
  get(): AgentRuntime;
  set(runtime: AgentRuntime | null): void;
}

const NAX_AGENT_SLOT: AgentRuntimeSlot = { get: getAgentRuntime, set: setAgentRuntime };

/**
 * Wraps the installed nax-agent runtime so every process it spawns is in the ledger. Returns the restore, which puts
 * the previous runtime back only while ours is still the installed one (an embedder that replaced it keeps its own).
 */
export function installProcessRecording(ledger: ProcessRecorder, slot: AgentRuntimeSlot = NAX_AGENT_SLOT): () => void {
  const inner = slot.get();
  const recording: AgentRuntime = {
    spawn(cmd, opts) {
      const child = inner.spawn(cmd, opts);
      ledger.spawned(child.pid, { group: opts.detached === true, source: 'native' });
      const forget = (): void => { ledger.exited(child.pid); };
      child.exited.then(forget, forget);
      return child;
    },
    glob: (pattern, opts) => inner.glob(pattern, opts),
    globSync: (pattern, opts) => inner.globSync(pattern, opts),
  };
  slot.set(recording);
  return () => {
    if (slot.get() === recording) slot.set(inner);
  };
}

export interface HostBootDeps {
  readonly platform: NodeJS.Platform;
  readonly readFile: (path: string) => Promise<string>;
  readonly run: (argv: readonly string[]) => Promise<string>;
}

const HOST_BOOT_DEPS: HostBootDeps = {
  platform: process.platform,
  readFile: (path) => readFile(path, 'utf8'),
  run: async (argv) => {
    const proc = Bun.spawn([...argv], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', env: { ...process.env, LC_ALL: 'C' } });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text;
  },
};

/**
 * The identity of the host's current boot, or '' when it cannot be read. After a reboot pids restart and the clock
 * may come up behind the ledger's rows, so a start-time check alone could match an unrelated process; a row is
 * signalled only in the host boot that wrote it.
 */
export async function readHostBootId(deps: HostBootDeps = HOST_BOOT_DEPS): Promise<string> {
  try {
    if (deps.platform === 'linux') {
      const id = (await deps.readFile('/proc/sys/kernel/random/boot_id')).trim();
      return id === '' ? '' : `linux:${id}`;
    }
    if (deps.platform === 'darwin') {
      const match = /sec = (\d+), usec = (\d+)/.exec(await deps.run(['sysctl', '-n', 'kern.boottime']));
      return match ? `darwin:${match[1]}.${match[2]}` : '';
    }
  } catch {
    // unreadable: '' below, and nothing is signalled
  }
  return '';
}

export interface ReapDeps {
  readonly journal: Pick<Journal, 'ownedProcessesOutside' | 'forgetOwnedProcess'>;
  /** This boot: its own rows are never touched. */
  readonly bootId: string;
  /** This host boot (`readHostBootId()`); '' signals nothing and keeps every known-host row for a later pass. */
  readonly hostBoot: string;
  readonly log: Logger;
  /** US-006: the identity probe for one pid; the production `ps` probe by default, injectable for tests. */
  readonly probe?: (pid: number) => Promise<ProcessStartProbe>;
  readonly kill?: (target: number, signal: NodeJS.Signals) => void;
  readonly selfPid?: number;
}

/**
 * Kills what earlier daemon boots' thread backends left running, then clears their rows. Called while this daemon holds
 * the runner home and before it accepts work. A pid is signalled only when its row was written in this same host boot
 * and its process started no later than the row (plus the nax pid reaper's slack): a pid recycled after the
 * original exited starts later and is skipped (D37). A wall clock stepped backwards within one host boot can still
 * defeat the start-time check; that is the same residual risk the nax pid reaper accepts.
 *
 * US-006: a row is forgotten only when the cleanup established what became of the process — it is definitively gone,
 * its pid was reused, it belongs to another host boot, it is protected, or it was signalled. An inconclusive probe or
 * a refused signal keeps the row, so the next boot pass retries against a freshly read identity instead of losing the
 * only record that the backend exists.
 */
export async function reapPreviousBootProcesses(deps: ReapDeps): Promise<number[]> {
  const probe = deps.probe ?? probeProcessStart;
  const kill = deps.kill ?? ((target: number, signal: NodeJS.Signals) => { process.kill(target, signal); });
  const selfPid = deps.selfPid ?? process.pid;
  const killed: number[] = [];
  for (const row of deps.journal.ownedProcessesOutside(deps.bootId)) {
    // Init and this daemon are never signalled, and their earlier-boot row answers nothing a later pass could use.
    if (row.pid <= 1 || row.pid === selfPid) {
      deps.journal.forgetOwnedProcess(row.pid, row.spawnedAtMs);
      continue;
    }
    // Without a recorded host boot no pass can ever match the row again, so keeping it would only leak.
    if (row.hostBoot === '') {
      deps.journal.forgetOwnedProcess(row.pid, row.spawnedAtMs);
      continue;
    }
    // This daemon could not read the host's boot identity: that says nothing about the process, so keep the row.
    if (deps.hostBoot === '') {
      deps.log.warn('could not read the host boot identity; keeping an earlier-boot process row for a later pass', { pid: row.pid });
      continue;
    }
    // A row of another host boot names a pid the reboot already freed; the kernel may have reused it since.
    if (row.hostBoot !== deps.hostBoot) {
      deps.journal.forgetOwnedProcess(row.pid, row.spawnedAtMs);
      continue;
    }

    const observation = await probe(row.pid).catch((error: unknown): ProcessStartProbe => (
      { outcome: 'indeterminate', reason: errorMessage(error) }
    ));
    if (observation.outcome === 'indeterminate') {
      deps.log.warn('could not identify a process left by an earlier runner boot; keeping its ownership row', { pid: row.pid, reason: observation.reason });
      continue;
    }
    if (observation.outcome === 'absent') {
      deps.journal.forgetOwnedProcess(row.pid, row.spawnedAtMs);
      continue;
    }
    // The pid answers, but with a process that started after this row was written: a recycled pid, not our backend.
    if (observation.startedAt.getTime() > row.spawnedAtMs + REGISTRATION_SLACK_MS) {
      deps.journal.forgetOwnedProcess(row.pid, row.spawnedAtMs);
      continue;
    }
    try {
      kill(row.group ? -row.pid : row.pid, 'SIGKILL');
      killed.push(row.pid);
      deps.journal.forgetOwnedProcess(row.pid, row.spawnedAtMs);
    } catch (error) {
      if (!isNoSuchProcess(error)) {
        // A refused signal (EPERM, an unreadable group, …) leaves the process alive: keep the row to retry.
        deps.log.warn('could not signal a process left by an earlier runner boot; keeping its ownership row', { pid: row.pid, error: errorMessage(error) });
        continue;
      }
      // ESRCH: the process ended between the probe and the signal, so the record is settled.
      deps.journal.forgetOwnedProcess(row.pid, row.spawnedAtMs);
    }
  }
  if (killed.length > 0) deps.log.warn('killed thread backend processes left by an earlier runner boot', { pids: killed });
  return killed;
}

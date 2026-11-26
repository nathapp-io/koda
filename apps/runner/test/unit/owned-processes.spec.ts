import { afterEach, describe, expect, test } from 'bun:test';
import type { AgentRuntime, AgentSpawnOptions, AgentSpawnResult } from '@nathapp/nax-agent';
import { readProcessStart } from '../../src/executor/pid-registry';
import { installProcessRecording, OwnedProcessLedger, readHostBootId, reapPreviousBootProcesses } from '../../src/daemon/owned-processes';
import { Journal } from '../../src/journal/journal';
import { createMemoryLogger } from '../../src/logger';
import { isNaxSandboxed } from '../helpers/test-environment';
import { waitFor } from '../helpers/wait';

const PIPE: AgentSpawnOptions = { stdout: 'pipe', stderr: 'pipe' };
const journals: Journal[] = [];
const spawned: number[] = [];

afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  for (const pid of spawned.splice(0)) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
});

function openJournal(): Journal {
  const journal = Journal.open(':memory:');
  journals.push(journal);
  return journal;
}

/** A runtime whose children never start: each spawn returns a handle the test exits by hand. */
function fakeRuntime(): { runtime: AgentRuntime; calls: Array<{ cmd: readonly string[]; opts: AgentSpawnOptions }>; exit: (pid: number) => void } {
  const calls: Array<{ cmd: readonly string[]; opts: AgentSpawnOptions }> = [];
  const exits = new Map<number, () => void>();
  let next = 40_000;
  const runtime: AgentRuntime = {
    spawn(cmd, opts) {
      calls.push({ cmd, opts });
      const pid = next++;
      const exited = new Promise<number>((resolve) => { exits.set(pid, () => resolve(0)); });
      return { pid, exited, exitCode: null, signalCode: null, stdout: new ReadableStream(), stderr: new ReadableStream(), kill: () => undefined } as AgentSpawnResult;
    },
    glob: () => (async function* () { /* none */ })(),
    globSync: () => [],
  };
  return { runtime, calls, exit: (pid) => exits.get(pid)?.() };
}

function memorySlot(initial: AgentRuntime): { get: () => AgentRuntime; set: (runtime: AgentRuntime | null) => void; current: () => AgentRuntime } {
  let installed: AgentRuntime | null = initial;
  return { get: () => installed ?? initial, set: (runtime) => { installed = runtime; }, current: () => installed ?? initial };
}

describe('#518 owned process ledger', () => {
  test('records a detached spawn as a process group under this boot and forgets it when it exits', async () => {
    const journal = openJournal();
    const ledger = new OwnedProcessLedger({ journal, bootId: 'boot-b', hostBoot: 'host-1', nowMs: () => 1_000, log: createMemoryLogger() });
    const fake = fakeRuntime();
    const slot = memorySlot(fake.runtime);
    installProcessRecording(ledger, slot);

    const child = slot.current().spawn(['sleep', '60'], { ...PIPE, detached: true });
    const attached = slot.current().spawn(['git', 'status'], PIPE);

    expect(fake.calls.map((call) => call.cmd[0])).toEqual(['sleep', 'git']);
    expect(journal.ownedProcessesOutside('other-boot')).toEqual([
      { pid: child.pid, group: true, spawnedAtMs: 1_000, bootId: 'boot-b', hostBoot: 'host-1', source: 'native' },
      { pid: attached.pid, group: false, spawnedAtMs: 1_000, bootId: 'boot-b', hostBoot: 'host-1', source: 'native' },
    ]);
    fake.exit(child.pid);
    await waitFor(() => journal.ownedProcessesOutside('other-boot').length === 1);
    expect(journal.ownedProcessesOutside('other-boot').map((row) => row.pid)).toEqual([attached.pid]);
  });

  test('the restore puts the previous runtime back only while the recording runtime is still installed', () => {
    const journal = openJournal();
    const ledger = new OwnedProcessLedger({ journal, bootId: 'boot-b', hostBoot: 'host-1', nowMs: () => 1_000, log: createMemoryLogger() });
    const fake = fakeRuntime();
    const slot = memorySlot(fake.runtime);
    const restore = installProcessRecording(ledger, slot);
    expect(slot.current()).not.toBe(fake.runtime);
    restore();
    expect(slot.current()).toBe(fake.runtime);

    const other = fakeRuntime().runtime;
    const restoreAgain = installProcessRecording(ledger, slot);
    slot.set(other);   // an embedder replaced the runtime after us
    restoreAgain();
    expect(slot.current()).toBe(other);
  });

  test('ACP hooks record the agent as a group leader and forget it on exit', () => {
    const journal = openJournal();
    const ledger = new OwnedProcessLedger({ journal, bootId: 'boot-b', hostBoot: 'host-1', nowMs: () => 2_000, log: createMemoryLogger() });
    ledger.spawned(5_150, { group: true, source: 'acp' });
    expect(journal.ownedProcessesOutside('x')).toEqual([{ pid: 5_150, group: true, spawnedAtMs: 2_000, bootId: 'boot-b', hostBoot: 'host-1', source: 'acp' }]);
    ledger.exited(5_150);
    expect(journal.ownedProcessesOutside('x')).toEqual([]);
  });

  test('a ledger write that fails is logged and never breaks the spawn', () => {
    const journal = Journal.open(':memory:');
    journal.close();
    const log = createMemoryLogger();
    const ledger = new OwnedProcessLedger({ journal, bootId: 'boot-b', hostBoot: 'host-1', nowMs: () => 1_000, log });
    const fake = fakeRuntime();
    const slot = memorySlot(fake.runtime);
    installProcessRecording(ledger, slot);
    expect(() => slot.current().spawn(['true'], PIPE)).not.toThrow();
    expect(JSON.stringify(log.lines)).toContain('could not record');
  });
});

describe('#518 reap at boot', () => {
  test('kills only verified processes of earlier boots, by group when it led one, and clears every earlier row', async () => {
    const journal = openJournal();
    const row = (pid: number, bootId: string, group = true) => ({ pid, group, spawnedAtMs: 10_000, bootId, hostBoot: 'host-1', source: 'native' as const });
    journal.recordOwnedProcess(row(101, 'old'));                  // verified group leader
    journal.recordOwnedProcess(row(102, 'old', false));           // verified, not a group leader
    journal.recordOwnedProcess(row(103, 'old'));                  // pid recycled: started well after the spawn
    journal.recordOwnedProcess(row(104, 'old'));                  // gone
    journal.recordOwnedProcess(row(process.pid, 'old'));          // never this daemon
    journal.recordOwnedProcess(row(1, 'old'));                    // never init
    journal.recordOwnedProcess(row(105, 'current'));              // this boot's own
    const starts: Record<number, number | null> = { 101: 9_000, 102: 10_000, 103: 60_000, 104: null };
    const kills: Array<[number, string]> = [];

    const killed = await reapPreviousBootProcesses({
      journal, bootId: 'current', hostBoot: 'host-1', log: createMemoryLogger(),
      startedAt: async (pid) => (starts[pid] === undefined || starts[pid] === null ? null : new Date(starts[pid] as number)),
      kill: (target, signal) => { kills.push([target, signal]); },
    });

    expect(kills).toEqual([[-101, 'SIGKILL'], [102, 'SIGKILL']]);
    expect(killed).toEqual([101, 102]);
    expect(journal.ownedProcessesOutside('nobody').map((r) => r.pid)).toEqual([105]);
  });

  test('rows from another host boot, or with an unknown host boot, are cleared and never signalled', async () => {
    const journal = openJournal();
    // After a reboot pids restart low and the clock may come up behind the rows: the start-time check alone would pass.
    journal.recordOwnedProcess({ pid: 201, group: true, spawnedAtMs: 10_000, bootId: 'old', hostBoot: 'host-0', source: 'acp' });
    journal.recordOwnedProcess({ pid: 202, group: true, spawnedAtMs: 10_000, bootId: 'old', hostBoot: '', source: 'acp' });
    const kills: number[] = [];
    const reap = (hostBoot: string) => reapPreviousBootProcesses({
      journal, bootId: 'current', hostBoot, log: createMemoryLogger(),
      startedAt: async () => new Date(5_000), kill: (target) => { kills.push(target); },
    });

    expect(await reap('host-1')).toEqual([]);
    expect(kills).toEqual([]);
    expect(journal.ownedProcessesOutside('nobody')).toEqual([]);

    journal.recordOwnedProcess({ pid: 203, group: true, spawnedAtMs: 10_000, bootId: 'old', hostBoot: 'host-1', source: 'acp' });
    expect(await reap('')).toEqual([]);   // this daemon cannot tell which host boot it is in: it signals nothing
    expect(kills).toEqual([]);
    expect(journal.ownedProcessesOutside('nobody')).toEqual([]);
  });

  test('readHostBootId reads the platform boot identity and answers an empty string when it cannot', async () => {
    expect(await readHostBootId({ platform: 'linux', readFile: async () => 'f3c1-9a\n', run: async () => '' })).toBe('linux:f3c1-9a');
    expect(await readHostBootId({ platform: 'darwin', readFile: async () => '', run: async () => '{ sec = 1794669775, usec = 197581 } Sat Nov 14 23:22:55 2026\n' })).toBe('darwin:1794669775.197581');
    expect(await readHostBootId({ platform: 'darwin', readFile: async () => '', run: async () => 'garbage' })).toBe('');
    expect(await readHostBootId({ platform: 'linux', readFile: async () => { throw new Error('EACCES'); }, run: async () => '' })).toBe('');
    expect(await readHostBootId({ platform: 'win32', readFile: async () => 'x', run: async () => 'x' })).toBe('');
  });

  test.skipIf(isNaxSandboxed())('readHostBootId gives this host a stable, non-empty boot identity', async () => {
    const real = await readHostBootId();
    expect(real).not.toBe('');
    expect(await readHostBootId()).toBe(real);
  });

  // Real processes and `ps`: process inspection is unavailable inside the nax session sandbox.
  test.skipIf(isNaxSandboxed())('a real detached group left by an earlier boot is killed with its children', async () => {
    const child = Bun.spawn(['sh', '-c', 'sleep 60 & echo $!; wait'], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', detached: true });
    spawned.push(child.pid);
    const reader = child.stdout.getReader();
    const first = new TextDecoder().decode((await reader.read()).value).trim();
    const grandchild = Number(first);
    spawned.push(grandchild);
    expect(Number.isInteger(grandchild) && grandchild > 1).toBe(true);
    const journal = openJournal();
    journal.recordOwnedProcess({ pid: child.pid, group: true, spawnedAtMs: Date.now(), bootId: 'old', hostBoot: 'host-1', source: 'native' });

    const killed = await reapPreviousBootProcesses({ journal, bootId: 'new', hostBoot: 'host-1', log: createMemoryLogger(), startedAt: readProcessStart });

    expect(killed).toEqual([child.pid]);
    await child.exited;
    await waitFor(() => { try { process.kill(grandchild, 0); return false; } catch { return true; } }, { timeoutMs: 5_000 });
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import type { AgentRuntime, AgentSpawnOptions, AgentSpawnResult } from '@nathapp/nax-agent';
import { probeProcessStart, readProcessStart, type ProcessStartProbe, type PsRunner } from '../../src/executor/pid-registry';
import { installProcessRecording, OwnedProcessLedger, readHostBootId, reapPreviousBootProcesses, type ReapDeps } from '../../src/daemon/owned-processes';
import { Journal } from '../../src/journal/journal';
import type { OwnedProcessRow } from '../../src/journal/types';
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
      probe: async (pid) => (starts[pid] === undefined || starts[pid] === null
        ? { outcome: 'absent' }
        : { outcome: 'found', startedAt: new Date(starts[pid] as number) }),
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
    const probes: number[] = [];
    const reap = (hostBoot: string) => reapPreviousBootProcesses({
      journal, bootId: 'current', hostBoot, log: createMemoryLogger(),
      probe: async (pid) => { probes.push(pid); return { outcome: 'found', startedAt: new Date(5_000) }; },
      kill: (target) => { kills.push(target); },
    });

    expect(await reap('host-1')).toEqual([]);
    expect(kills).toEqual([]);
    expect(probes).toEqual([]);
    expect(journal.ownedProcessesOutside('nobody')).toEqual([]);

    journal.recordOwnedProcess({ pid: 203, group: true, spawnedAtMs: 10_000, bootId: 'old', hostBoot: 'host-1', source: 'acp' });
    expect(await reap('')).toEqual([]);   // this daemon cannot tell which host boot it is in: it signals nothing
    expect(kills).toEqual([]);
    expect(journal.ownedProcessesOutside('nobody').map((r) => r.pid)).toEqual([203]);   // kept for a later pass (US-006)
    expect(await reap('host-1')).toEqual([203]);
    expect(kills).toEqual([-203]);
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

    const killed = await reapPreviousBootProcesses({ journal, bootId: 'new', hostBoot: 'host-1', log: createMemoryLogger() });

    expect(killed).toEqual([child.pid]);
    await child.exited;
    await waitFor(() => { try { process.kill(grandchild, 0); return false; } catch { return true; } }, { timeoutMs: 5_000 });
  });

  // US-006 AC-14 with the real process command: a pid the kernel no longer knows is not inspected, only confirmed.
  test.skipIf(isNaxSandboxed())('AC-14: the production probe clears the row of a pid the kernel no longer knows', async () => {
    const exited = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
    await exited.exited;
    const journal = openJournal();
    journal.recordOwnedProcess({ pid: exited.pid, group: false, spawnedAtMs: Date.now(), bootId: 'old', hostBoot: 'host-1', source: 'native' });
    const kills: number[] = [];

    const killed = await reapPreviousBootProcesses({
      journal, bootId: 'new', hostBoot: 'host-1', log: createMemoryLogger(),
      kill: (target) => { kills.push(target); },
    });

    expect(killed).toEqual([]);
    expect(kills).toEqual([]);
    expect(journal.ownedProcessesOutside('new')).toEqual([]);
  });
});

const RECORDED: OwnedProcessRow = { pid: 4_340, group: true, spawnedAtMs: 10_000, bootId: 'old', hostBoot: 'host-1', source: 'native' };
const CURRENT_BOOT = 'current';
const found = (startedAtMs: number): ProcessStartProbe => ({ outcome: 'found', startedAt: new Date(startedAtMs) });
const ABSENT: ProcessStartProbe = { outcome: 'absent' };
const UNKNOWN: ProcessStartProbe = { outcome: 'indeterminate', reason: 'the process command could not be inspected' };
const errno = (code: string): () => Error & { code: string } => () => Object.assign(new Error(`kill ${code}`), { code });
/** The kernel's answer to `signal 0` when the operation is refused rather than answered. */
const refuseWith = (code: string) => (): void => { throw errno(code)(); };

/** One journal seeded with earlier-boot rows, plus the signals and queries a reaper pass records. */
function fixture(rows: Array<Partial<OwnedProcessRow>> = [RECORDED]): {
  journal: Journal;
  kills: Array<[number, NodeJS.Signals]>;
  rows: () => OwnedProcessRow[];
  reap: (probe: (pid: number) => Promise<ProcessStartProbe>, opts?: Partial<ReapDeps>) => Promise<number[]>;
} {
  const journal = openJournal();
  for (const over of rows) journal.recordOwnedProcess({ ...RECORDED, ...over });
  const kills: Array<[number, NodeJS.Signals]> = [];
  return {
    journal,
    kills,
    rows: () => journal.ownedProcessesOutside(CURRENT_BOOT),
    reap: (probe, opts = {}) => reapPreviousBootProcesses({
      journal, bootId: CURRENT_BOOT, hostBoot: RECORDED.hostBoot, log: createMemoryLogger(),
      probe, kill: (target, signal) => { kills.push([target, signal]); },
      ...opts,
    }),
  };
}

describe('US-006: an indeterminate cleanup keeps the ownership row for a retry', () => {
  test('AC-1: an inspection failure retains the ownership row and sends no signal', async () => {
    const answered = fixture();
    expect(await answered.reap(async () => UNKNOWN)).toEqual([]);
    expect(answered.kills).toEqual([]);
    expect(answered.rows()).toEqual([RECORDED]);

    const thrown = fixture();
    expect(await thrown.reap(async () => { throw new Error('temporary lookup error'); })).toEqual([]);
    expect(thrown.kills).toEqual([]);
    expect(thrown.rows()).toEqual([RECORDED]);
  });

  test('AC-2: a retained row is revalidated and signalled on a later boot pass', async () => {
    const f = fixture();
    expect(await f.reap(async () => UNKNOWN)).toEqual([]);
    expect(f.rows()).toEqual([RECORDED]);

    // The later pass rereads the identity: the pid now answers with the recorded process's start time.
    expect(await f.reap(async () => found(10_000))).toEqual([RECORDED.pid]);
    expect(f.kills).toEqual([[-RECORDED.pid, 'SIGKILL']]);
    expect(f.rows()).toEqual([]);
  });

  test('AC-3: a denied signal retains the ownership row', async () => {
    const f = fixture();
    const attempted: number[] = [];
    const killed = await f.reap(async () => found(10_000), { kill: (target) => { attempted.push(target); throw errno('EPERM')(); } });

    expect(killed).toEqual([]);
    expect(attempted).toEqual([-RECORDED.pid]);
    expect(f.rows()).toEqual([RECORDED]);
  });

  test('AC-4: a row kept after a denied signal is cleared when the pid is later reused', async () => {
    const f = fixture();
    await f.reap(async () => found(10_000), { kill: () => { throw errno('EPERM')(); } });
    expect(f.rows()).toEqual([RECORDED]);

    // The pid now belongs to a process started well after the row was written: the record is obsolete, not the process.
    expect(await f.reap(async () => found(70_000))).toEqual([]);
    expect(f.kills).toEqual([]);
    expect(f.rows()).toEqual([]);
  });

  test('AC-5: a confirmed absent process has its ownership row cleared', async () => {
    const f = fixture();
    expect(await f.reap(async () => ABSENT)).toEqual([]);
    expect(f.kills).toEqual([]);
    expect(f.rows()).toEqual([]);
  });

  test('AC-6: a signal that reports ESRCH clears the ownership row', async () => {
    const f = fixture();
    const attempted: number[] = [];
    const killed = await f.reap(async () => found(10_000), { kill: (target) => { attempted.push(target); throw errno('ESRCH')(); } });

    expect(killed).toEqual([]);
    expect(attempted).toEqual([-RECORDED.pid]);
    expect(f.rows()).toEqual([]);
  });

  test('AC-7: a verified process and a verified group are each signalled exactly once', async () => {
    const f = fixture([{ pid: 4_340, group: true }, { pid: 4_341, group: false }]);
    const killed = await f.reap(async (pid) => found(pid === 4_340 ? 10_000 : 9_500));

    expect(f.kills).toEqual([[-4_340, 'SIGKILL'], [4_341, 'SIGKILL']]);
    expect(killed).toEqual([4_340, 4_341]);
    expect(f.rows()).toEqual([]);
  });

  test('AC-8: an earlier-boot row of a protected pid is cleared without a signal', async () => {
    const f = fixture([{ pid: 0 }, { pid: 1 }, { pid: 999 }]);
    const probes: number[] = [];
    const killed = await f.reap(async (pid) => { probes.push(pid); return found(10_000); }, { selfPid: 999 });

    expect(killed).toEqual([]);
    expect(f.kills).toEqual([]);
    expect(probes).toEqual([]);   // a protected pid is never even probed
    expect(f.rows()).toEqual([]);
  });

  test('AC-9: a row with no recorded host identity is cleared without a signal', async () => {
    const f = fixture([{ hostBoot: '' }]);
    const probes: number[] = [];
    const killed = await f.reap(async (pid) => { probes.push(pid); return found(10_000); });

    expect(killed).toEqual([]);
    expect(f.kills).toEqual([]);
    expect(probes).toEqual([]);
    expect(f.rows()).toEqual([]);
  });

  test('AC-10: a row from a confirmed different host boot is cleared without a signal', async () => {
    const f = fixture([{ hostBoot: 'host-0' }]);
    const probes: number[] = [];
    const killed = await f.reap(async (pid) => { probes.push(pid); return found(10_000); });

    expect(killed).toEqual([]);
    expect(f.kills).toEqual([]);
    expect(probes).toEqual([]);
    expect(f.rows()).toEqual([]);
  });

  test('AC-11: while the current host identity is unreadable a known-host row is kept for a retry', async () => {
    const f = fixture([RECORDED, { pid: 4_341, hostBoot: '' }]);
    const probes: number[] = [];
    const killed = await f.reap(async (pid) => { probes.push(pid); return found(10_000); }, { hostBoot: '' });

    expect(killed).toEqual([]);
    expect(f.kills).toEqual([]);
    expect(probes).toEqual([]);
    expect(f.rows()).toEqual([RECORDED]);   // the host-less row is unusable; the known-host row waits for a readable pass

    expect(await f.reap(async () => found(10_000))).toEqual([RECORDED.pid]);
    expect(f.rows()).toEqual([]);
  });

  test('AC-12: this daemon boot\'s own rows stay untouched', async () => {
    const f = fixture([RECORDED]);
    f.journal.recordOwnedProcess({ ...RECORDED, pid: 4_342, bootId: CURRENT_BOOT });
    const probes: number[] = [];

    await f.reap(async (pid) => { probes.push(pid); return found(10_000); });

    expect(probes).toEqual([RECORDED.pid]);
    expect(f.journal.ownedProcessesOutside('nobody').map((row) => row.pid)).toEqual([4_342]);
  });
});

describe('US-006: the production probe with controlled process-command output', () => {
  /** The real probe, with only the process command's answer and the kernel's existence check supplied. */
  const productionProbe = (run: PsRunner, exists: (pid: number) => void = () => undefined) =>
    async (pid: number): Promise<ProcessStartProbe> => probeProcessStart(pid, { run, exists });

  test('AC-13: a malformed timestamp, a launch failure and a denied inspection each retain the row without a signal', async () => {
    const cases: Array<[string, (pid: number) => Promise<ProcessStartProbe>]> = [
      ['malformed timestamp', productionProbe(async () => ({ exitCode: 0, stdout: 'lstart is not a timestamp', stderr: '' }))],
      ['launch failure', productionProbe(async () => { throw Object.assign(new Error('spawn ps EACCES'), { code: 'EACCES' }); })],
      ['denied inspection', productionProbe(async () => ({ exitCode: 126, stdout: '', stderr: '/bin/sh: /bin/ps: Operation not permitted' }))],
      ['denied identity check', productionProbe(async () => ({ exitCode: 1, stdout: '', stderr: '' }), refuseWith('EPERM'))],
    ];

    for (const [name, probe] of cases) {
      expect(await probe(RECORDED.pid), name).toEqual({ outcome: 'indeterminate', reason: expect.any(String) });
      const f = fixture();
      expect(await f.reap(probe), name).toEqual([]);
      expect(f.kills, name).toEqual([]);
      expect(f.rows(), name).toEqual([RECORDED]);
    }
  });

  test('AC-14: a definitively absent pid has its row cleared through the production probe', async () => {
    const probe = productionProbe(async () => ({ exitCode: 1, stdout: '', stderr: '' }), refuseWith('ESRCH'));
    expect(await probe(RECORDED.pid)).toEqual({ outcome: 'absent' });

    const f = fixture();
    expect(await f.reap(probe)).toEqual([]);
    expect(f.kills).toEqual([]);
    expect(f.rows()).toEqual([]);
  });

  test('the probe reads the process command\'s lstart as UTC, so the start-time comparison is host-independent', async () => {
    const text = 'Sat Nov 28 05:30:00 2026';
    const probe = productionProbe(async () => ({ exitCode: 0, stdout: `${text}\n`, stderr: '' }));

    expect(await probe(RECORDED.pid)).toEqual({ outcome: 'found', startedAt: new Date('2026-11-28T05:30:00.000Z') });
  });

  test('readProcessStart keeps its Date-or-null contract for the executor callers', async () => {
    const run = (stdout: string): PsRunner => async () => ({ exitCode: stdout === '' ? 1 : 0, stdout, stderr: '' });

    expect(await readProcessStart(RECORDED.pid, { run: run('Sat Nov 28 05:30:00 2026') })).toEqual(new Date('2026-11-28T05:30:00.000Z'));
    expect(await readProcessStart(RECORDED.pid, { run: run('nonsense') })).toBeNull();
    expect(await readProcessStart(RECORDED.pid, { run: async () => { throw new Error('no ps'); } })).toBeNull();
    expect(await readProcessStart(RECORDED.pid, { run: run(''), exists: refuseWith('EPERM') })).toBeNull();
    expect(await readProcessStart(0, { run: async () => { throw new Error('never run'); } })).toBeNull();
  });
});

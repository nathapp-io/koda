import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getAgentRuntime } from '@nathapp/nax-agent';
import { parseRunnerConfig, resolveHome } from '../../src/config/runner-config';
import { startDaemon } from '../../src/daemon/daemon';
import { readHostBootId } from '../../src/daemon/owned-processes';
import { Journal } from '../../src/journal/journal';
import { createMemoryLogger } from '../../src/logger';
import type { FetchFn } from '../../src/sync/http';
import { FakeExecutor } from '../helpers/fake-executor';
import { isNaxSandboxed } from '../helpers/test-environment';
import { makeTempDirs } from '../helpers/tmp';
import { waitFor } from '../helpers/wait';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const leftovers: number[] = [];
afterEach(() => {
  for (const pid of leftovers.splice(0)) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
  }
});

const SERVER = 'https://runner.test';
const fetchFn: FetchFn = async (rawUrl, init) => {
  const url = new URL(new Request(rawUrl, init).url);
  const envelope = (data: unknown) => new Response(JSON.stringify({ ret: 0, data }), { status: 200 });
  if (url.pathname === '/api/fleet/runner/me') return envelope({ id: 'r1', name: 'box', labels: [], capacity: 1, enabled: true });
  if (url.pathname === '/api/fleet/runner/sync') {
    await Bun.sleep(25);
    return envelope({ jobAcks: [], commands: [], gitTokens: [], gitTokenErrors: [], unknownJobIds: [] });
  }
  return new Response('nope', { status: 404 });
};

async function setup() {
  const base = await tmp.make('op');
  const home = resolveHome({}, join(base, 'home'));
  await mkdir(home.dir, { recursive: true });
  const config = parseRunnerConfig({
    serverUrl: SERVER, workspaceRoot: join(base, 'ws'), naxHome: join(base, 'naxhome'), jobRetentionDays: 1, socketDir: join(base, 's'),
    capabilities: { nax: { version: '0.83.0', protocols: ['native'] }, sandbox: { available: true }, tools: { git: true, gh: true, glab: false }, executors: ['host'] },
  }, {});
  const identity = { runnerId: 'r1', apiKey: 'kr_test', serverUrl: SERVER, name: 'box', enrolledAt: '2026-10-01T00:00:00.000Z' };
  return { home, config, identity };
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

describe('#518 daemon start reaps what an earlier boot left', () => {
  // Real processes and `ps`: process inspection is unavailable inside the nax session sandbox.
  test.skipIf(isNaxSandboxed())('a detached group recorded by an earlier boot is killed before the daemon takes work', async () => {
    const s = await setup();
    const orphan = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore', detached: true });
    leftovers.push(orphan.pid);
    const seed = Journal.open(s.home.journalPath);
    seed.recordOwnedProcess({ pid: orphan.pid, group: true, spawnedAtMs: Date.now(), bootId: 'earlier-boot', hostBoot: await readHostBootId(), source: 'acp' });
    seed.close();

    const log = createMemoryLogger();
    const daemon = await startDaemon({ fetchFn, home: s.home, config: s.config, identity: s.identity, tuning: { syncMinGapMs: 5 }, log, executorFactory: () => new FakeExecutor() });
    try {
      // Bounded well inside the test timeout: bun's own timeout SIGTERMs the test's children, which would pass this.
      const outcome = await Promise.race([orphan.exited.then(() => orphan.signalCode), Bun.sleep(3_000).then(() => 'still running')]);
      expect(outcome).toBe('SIGKILL');
      expect(alive(orphan.pid)).toBe(false);
      expect(daemon.journal.ownedProcessesOutside(daemon.bootId)).toEqual([]);
      expect(JSON.stringify(log.lines)).toContain('left by an earlier runner boot');
    } finally {
      await daemon.stop();
    }
  });

  test.skipIf(isNaxSandboxed())('a backend process left by a crashed daemon is killed by the next daemon on the home', async () => {
    const s = await setup();
    const start = () => startDaemon({ fetchFn, home: s.home, config: s.config, identity: s.identity, tuning: { syncMinGapMs: 5 }, log: createMemoryLogger(), executorFactory: () => new FakeExecutor() });
    const first = await start();
    const child = getAgentRuntime().spawn(['sh', '-c', 'sleep 60 & wait'], { stdout: 'pipe', stderr: 'pipe', detached: true });
    leftovers.push(child.pid);
    first.crash();
    await first.stopped;
    expect(alive(child.pid)).toBe(true);

    const second = await start();
    try {
      const outcome = await Promise.race([child.exited.then(() => 'exited'), Bun.sleep(3_000).then(() => 'still running')]);
      expect(outcome).toBe('exited');
      // The whole group went, not only its leader: no process is left in it.
      await waitFor(() => { try { process.kill(-child.pid, 0); return false; } catch { return true; } }, { timeoutMs: 3_000 });
    } finally {
      await second.stop();
    }
  });

  test.skipIf(isNaxSandboxed())('nax-agent spawns are recorded under this boot while it runs, and the runtime is restored at stop', async () => {
    const s = await setup();
    const original = getAgentRuntime();
    const daemon = await startDaemon({ fetchFn, home: s.home, config: s.config, identity: s.identity, tuning: { syncMinGapMs: 5 }, log: createMemoryLogger(), executorFactory: () => new FakeExecutor() });
    let pid = 0;
    try {
      expect(getAgentRuntime()).not.toBe(original);
      const child = getAgentRuntime().spawn(['sleep', '60'], { stdout: 'pipe', stderr: 'pipe', detached: true });
      pid = child.pid;
      leftovers.push(pid);
      expect(daemon.journal.ownedProcessesOutside('another-boot')).toEqual([
        expect.objectContaining({ pid, group: true, bootId: daemon.bootId, hostBoot: await readHostBootId(), source: 'native' }),
      ]);
      child.kill('SIGKILL');
      await waitFor(() => daemon.journal.ownedProcessesOutside('another-boot').length === 0);
    } finally {
      await daemon.stop();
    }
    expect(getAgentRuntime()).toBe(original);
  });
});

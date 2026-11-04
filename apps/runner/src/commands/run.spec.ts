import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveHome } from '../config/runner-config';
import { writeIdentity } from '../identity/identity-store';
import { createMemoryLogger } from '../logger';
import { makeTempDirs } from '../../test/helpers/tmp';
import { runCommand, type RunDeps } from './run';
import { NaxUnavailableError } from '../nax/nax-cli';
import { probeAcpAgents } from '../capabilities/acp-agent-probe';
import type { DaemonHandle, DaemonOptions } from '../daemon/daemon';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

async function enrolledHome(serverUrl = 'https://koda.example.com') {
  const dir = await tmp.make('run');
  const home = resolveHome({}, join(dir, 'home'));
  await mkdir(home.dir, { recursive: true });
  await writeFile(home.configPath, JSON.stringify({
    serverUrl, workspaceRoot: join(dir, 'ws'),
    capabilities: { nax: { version: '1', protocols: ['native'] }, sandbox: { available: false }, tools: { git: true, gh: true, glab: false }, executors: ['host'] },
  }));
  await writeIdentity(home.identityPath, { runnerId: 'r1', apiKey: 'kr_x', serverUrl, name: 'box', enrolledAt: 't' });
  return home;
}
function harness(stopper: (resolve: (v: 'stopped' | { kind: 'protocol' | 'auth'; message: string }) => void) => void, env: NodeJS.ProcessEnv = {}) {
  const handlers: Array<() => void> = [];
  const signals = new Map<string, () => void>();
  let stopped = 0;
  let reprobes = 0;
  let stoppedOnce = false;
  const log = createMemoryLogger();
  const started: DaemonOptions[] = [];
  const deps: RunDeps = {
    env, log,
    start: async (options) => {
      started.push(options);
      let resolveStopped: (v: 'stopped' | { kind: 'protocol' | 'auth'; message: string }) => void = () => undefined;
      const stoppedPromise = new Promise<'stopped' | { kind: 'protocol' | 'auth'; message: string }>((r) => { resolveStopped = r; });
      stopper(resolveStopped);
      return {
        bootId: 'b', journal: null as never, supervisor: null as never, stopped: stoppedPromise as never,
        stop: async () => { if (!stoppedOnce) { stoppedOnce = true; stopped += 1; } resolveStopped('stopped'); },
        crash: () => undefined,
        reprobe: async () => { reprobes += 1; },
      } satisfies DaemonHandle;
    },
    onSignal: (signal, handler) => { handlers.push(handler); signals.set(signal, handler); },
  };
  return { deps, handlers, signals, log, started, get stopped() { return stopped; }, get reprobes() { return reprobes; } };
}

describe('runCommand', () => {
  test('returns 1 with a readable message when the machine is not enrolled', async () => {
    const h = harness(() => undefined);
    const dir = await tmp.make('run');
    expect(await runCommand(join(dir, 'nothing'), h.deps)).toBe(1);
    expect(h.log.lines.some((l) => l.level === 'error' && /enroll/.test(l.message))).toBe(true);
  });
  test('returns 1 when identity and config point at different servers', async () => {
    const home = await enrolledHome();
    await writeIdentity(home.identityPath, { runnerId: 'r1', apiKey: 'kr_x', serverUrl: 'https://elsewhere.example.com', name: 'box', enrolledAt: 't' });
    expect(await runCommand(home.dir, harness(() => undefined).deps)).toBe(1);
  });
  test('SIGTERM or SIGINT stops the daemon cleanly (exit 0) without killing jobs', async () => {
    const home = await enrolledHome();
    const h = harness(() => undefined);
    const finished = runCommand(home.dir, h.deps);
    await Bun.sleep(20);
    expect(h.handlers).toHaveLength(3);
    h.handlers[0]();
    expect(await finished).toBe(0);
    expect(h.stopped).toBe(1);
  });
  test('a stop imposed by the server (426 or 401) is exit code 2 and is logged', async () => {
    const home = await enrolledHome();
    const h = harness((resolve) => resolve({ kind: 'auth', message: 'runner key rejected' }));
    expect(await runCommand(home.dir, h.deps)).toBe(2);
    expect(h.log.lines.some((l) => l.level === 'error')).toBe(true);
  });
  // OPS-1: under launchd a plain KeepAlive would restart the runner every 10 s after a server refusal, so the
  // supervisor-aware exit 0 tells launchd "do not restart". systemd's RestartPreventExitStatus=2 stays as is.
  test('AC-4: under launchd a server stop (401) is exit 0 and is still logged at error level', async () => {
    const home = await enrolledHome();
    const h = harness((resolve) => resolve({ kind: 'auth', message: 'runner key rejected' }), { KODA_RUNNER_SUPERVISOR: 'launchd' });
    expect(await runCommand(home.dir, h.deps)).toBe(0);
    const line = h.log.lines.find((l) => l.level === 'error' && l.message.startsWith('stopped by the server (auth)'));
    expect(line).toBeDefined();
    expect(line?.message).toBe('stopped by the server (auth): runner key rejected');
  });
  test('AC-5: without KODA_RUNNER_SUPERVISOR a server stop (426) is still exit 2', async () => {
    const home = await enrolledHome();
    const h = harness((resolve) => resolve({ kind: 'protocol', message: 'Unsupported protocol version' }));
    expect(await runCommand(home.dir, h.deps)).toBe(2);
  });
  test('AC-6: KODA_RUNNER_SUPERVISOR launchd does not soften a missing identity (exit 1)', async () => {
    const dir = await tmp.make('run');
    const home = resolveHome({}, join(dir, 'home'));
    await mkdir(home.dir, { recursive: true });
    await writeFile(home.configPath, JSON.stringify({ serverUrl: 'https://koda.example.com', workspaceRoot: join(dir, 'ws') }));
    const h = harness(() => undefined, { KODA_RUNNER_SUPERVISOR: 'launchd' });
    expect(await runCommand(home.dir, h.deps)).toBe(1);
    expect(h.stopped).toBe(0);
  });
  test('D102: SIGHUP asks the daemon to probe again and does not stop it', async () => {
    const home = await enrolledHome();
    const h = harness(() => undefined);
    const finished = runCommand(home.dir, h.deps);
    await Bun.sleep(20);
    h.signals.get('SIGHUP')?.();
    await Bun.sleep(5);
    expect(h.reprobes).toBe(1);
    expect(h.stopped).toBe(0);
    h.signals.get('SIGTERM')?.();
    expect(await finished).toBe(0);
  });
  test('D97, D103: a StartupError (nax too old, workspace untrusted) is exit 1 with its message logged as is', async () => {
    const home = await enrolledHome();
    const h = harness(() => undefined);
    const deps: RunDeps = { ...h.deps, start: async () => { throw new NaxUnavailableError('koda-runner needs nax 0.83.1 or newer (found 0.80.0)'); } };
    expect(await runCommand(home.dir, deps)).toBe(1);
    expect(h.log.lines.some((l) => l.level === 'error' && l.message === 'koda-runner needs nax 0.83.1 or newer (found 0.80.0)')).toBe(true);
  });
  // thread-agents-modes US-002: the production runner is the only caller that probes ACP agents, and it hands the
  // daemon the real probe — never a stub — so a sync can advertise claude, codex and cursor.
  test('US-002 AC-13: the run command starts the daemon with probeAcpAgents itself as its acpProbe', async () => {
    const home = await enrolledHome();
    const h = harness(() => undefined);
    const finished = runCommand(home.dir, h.deps);
    await Bun.sleep(20);
    expect(h.started).toHaveLength(1);
    expect(h.started[0]?.acpProbe).toBe(probeAcpAgents);
    h.signals.get('SIGTERM')?.();
    expect(await finished).toBe(0);
  });
});

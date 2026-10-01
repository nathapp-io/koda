import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveHome } from '../config/runner-config';
import { writeIdentity } from '../identity/identity-store';
import { createMemoryLogger } from '../logger';
import { makeTempDirs } from '../../test/helpers/tmp';
import { runCommand, type RunDeps } from './run';
import { NaxUnavailableError } from '../nax/nax-cli';
import type { DaemonHandle } from '../daemon/daemon';

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
function harness(stopper: (resolve: (v: 'stopped' | { kind: 'protocol' | 'auth'; message: string }) => void) => void) {
  const handlers: Array<() => void> = [];
  const signals = new Map<string, () => void>();
  let stopped = 0;
  let reprobes = 0;
  let stoppedOnce = false;
  const log = createMemoryLogger();
  const deps: RunDeps = {
    env: {}, log,
    start: async () => {
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
  return { deps, handlers, signals, log, get stopped() { return stopped; }, get reprobes() { return reprobes; } };
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
});

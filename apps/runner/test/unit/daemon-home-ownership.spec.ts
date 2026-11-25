/**
 * US-001: one live runner daemon per physical runner home.
 *
 * The unit under test is `startDaemon`'s ownership of the home (`daemon-lock.db`): it is taken after the Git preflight
 * and the home-directory preparation, and before any daemon-owned startup side effect; it is released when the
 * journal lifecycle of that handle retires. Contention, independence and restart are exercised with real OS
 * processes (`test/fixtures/daemon-home-worker.ts`), real SQLite and an inert executor, plus in-process handles for
 * the retirement edges.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FleetCommandOut, SyncRequest } from '@nathapp/fleet-protocol';
import { runCommand } from '../../src/commands/run';
import { loadRunnerConfig, resolveHome, type RunnerConfig } from '../../src/config/runner-config';
import { startDaemon, HomeOwnershipError, RUNNER_HOME_LOCK_FILE, type DaemonHandle, type DaemonOptions } from '../../src/daemon/daemon';
import { readIdentity, type RunnerIdentityFile } from '../../src/identity/identity-store';
import { Journal } from '../../src/journal/journal';
import { createMemoryLogger, type MemoryLogger } from '../../src/logger';
import type { FetchFn } from '../../src/sync/http';
import type { HomeWorkerSpec, WorkerState } from '../fixtures/daemon-home-worker';
import { assignFor } from '../helpers/assign';
import { FakeExecutor } from '../helpers/fake-executor';
import { makeTempDirs } from '../helpers/tmp';
import { waitFor } from '../helpers/wait';

const tmp = makeTempDirs();
const WORKER = join(import.meta.dir, '..', 'fixtures', 'daemon-home-worker.ts');
const MAIN = join(import.meta.dir, '..', '..', 'src', 'main.ts');
const FAKE_NAX = join(import.meta.dir, '..', 'fixtures', 'fake-nax.ts');
/** Loopback, so a real client built by `runCommand` fails at once instead of resolving a name. */
const SERVER_URL = 'http://127.0.0.1:9';
const TUNING = { syncMinGapMs: 5, statusPollMs: 5, syncTimeoutMs: 2_000, ackPollMs: 5 };
const CAPABILITIES = {
  nax: { version: '0.83.1', protocols: ['native'] }, sandbox: { available: true },
  profiles: {}, credentials: [], tools: { git: true, gh: false, glab: false }, executors: ['host'],
};
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

/** A socket directory path that does not exist yet and is short enough for a unix socket name. */
const shortPaths: string[] = [];
async function shortSocketDir(): Promise<string> {
  const dir = join(tmpdir(), `k${randomUUID().slice(0, 6)}`);
  shortPaths.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(shortPaths.map((dir) => rm(dir, { recursive: true, force: true })));
  await tmp.cleanup();
});

interface Home {
  readonly base: string;
  readonly dir: string;
  readonly workspaceRoot: string;
  readonly socketDir: string;
  readonly naxHome: string;
}

/** A temporary enrolled home: runner.json and identity.json, and the runner resources beside it. */
async function enrolledHome(prefix: string, over: { naxMode?: boolean } = {}): Promise<Home> {
  const base = await tmp.make(prefix);
  const home: Home = { base, dir: join(base, 'home'), workspaceRoot: join(base, 'ws'), socketDir: await shortSocketDir(), naxHome: join(base, 'nax') };
  for (const dir of [home.dir, home.workspaceRoot, home.naxHome]) await mkdir(dir, { recursive: true });
  await writeFile(join(home.dir, 'runner.json'), JSON.stringify({
    serverUrl: SERVER_URL, workspaceRoot: home.workspaceRoot, naxHome: home.naxHome, socketDir: home.socketDir, jobRetentionDays: 1,
    naxCommand: ['bun', FAKE_NAX],
    ...(over.naxMode === true ? {} : { capabilities: CAPABILITIES }),
  }));
  await writeFile(join(home.dir, 'identity.json'), JSON.stringify({
    runnerId: 'r-home', apiKey: 'kr_home_ownership', serverUrl: SERVER_URL, name: 'home', enrolledAt: '2026-01-01T00:00:00.000Z',
  }));
  return home;
}

/** An independent SQLite connection holding an active write transaction on the home's lock database. */
interface Writer {
  release(): void;
}
async function holdLockDatabase(homeDir: string): Promise<Writer> {
  const db = new Database(join(homeDir, RUNNER_HOME_LOCK_FILE), { create: true });
  db.exec('PRAGMA busy_timeout = 0');
  db.exec('CREATE TABLE IF NOT EXISTS independent_writer (x TEXT)');
  db.exec('BEGIN IMMEDIATE');
  return { release: () => { db.exec('ROLLBACK'); db.close(); } };
}

interface SyncEntry {
  readonly method: string;
  readonly path: string;
  readonly bootId: string;
}
interface LaunchEntry {
  readonly jobId: string;
  readonly leaseEpoch: number;
}
interface AttemptEntry {
  readonly name: string;
}

function parseLines<T>(text: string): T[] {
  return text.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as T);
}

/** One runner process of the ownership fixture, driven through its control directory. */
class HomeWorker {
  readonly ctrl: string;
  readonly spec: HomeWorkerSpec;
  private readonly proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  private readonly exit: Promise<number>;
  private readonly out: string[] = [];
  private readonly err: string[] = [];
  private readonly drains: Array<Promise<void>> = [];
  private exited = false;

  private constructor(ctrl: string, spec: HomeWorkerSpec, proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>) {
    this.ctrl = ctrl;
    this.spec = spec;
    this.proc = proc;
    this.drains.push(this.drain(proc.stdout, this.out), this.drain(proc.stderr, this.err));
    this.exit = proc.exited.then((code) => {
      this.exited = true;
      return code;
    });
  }

  private async drain(stream: ReadableStream<Uint8Array>, sink: string[]): Promise<void> {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      sink.push(new TextDecoder().decode(value));
    }
  }

  static async spawn(
    spec: Omit<HomeWorkerSpec, 'ctrlDir' | 'serverUrl' | 'runnerId'> & { ctrl?: string; env?: Record<string, string> },
  ): Promise<HomeWorker> {
    const ctrl = spec.ctrl ?? await tmp.make('ctrl');
    await mkdir(ctrl, { recursive: true });
    const full: HomeWorkerSpec = { ctrlDir: ctrl, serverUrl: SERVER_URL, runnerId: 'r-home', ...spec };
    const specPath = join(ctrl, 'spec.json');
    await writeFile(specPath, JSON.stringify(full));
    const proc = Bun.spawn(['bun', WORKER, specPath], {
      cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...spec.env },
    });
    return new HomeWorker(ctrl, full, proc);
  }

  get gone(): boolean {
    return this.exited;
  }

  stderr(): string {
    return this.err.join('');
  }

  /** The process has passed its Git preflight and sits immediately before its ownership attempt. */
  async ready(timeoutMs = 20_000): Promise<void> {
    await this.waitFor('ready', timeoutMs, 'never signalled readiness');
  }

  /** Release the attempt. */
  async release(): Promise<void> {
    await writeFile(join(this.ctrl, 'go'), '');
  }

  async write(name: string, content: unknown): Promise<void> {
    await writeFile(join(this.ctrl, name), typeof content === 'string' ? content : JSON.stringify(content));
  }

  async waitFor(name: string, timeoutMs = 15_000, what = 'timed out'): Promise<void> {
    await waitFor(() => existsSync(join(this.ctrl, name)), {
      timeoutMs, intervalMs: 5,
      message: `worker (${this.spec.mode}, ${this.spec.home}): ${what} waiting for ${name}; stderr: ${this.stderr()}`,
    });
  }

  async records<T>(name: string): Promise<T[]> {
    const text = await readFile(join(this.ctrl, `${name}.jsonl`), 'utf8').catch(() => '');
    return parseLines<T>(text);
  }

  async waitForRecord<T>(name: string, timeoutMs = 15_000, match: (entry: T) => boolean = () => true): Promise<T> {
    let found: T | null = null;
    await waitFor(async () => {
      found = (await this.records<T>(name)).find(match) ?? null;
      return found !== null;
    }, { timeoutMs, intervalMs: 10, message: `worker (${this.spec.mode}, ${this.spec.home}): no ${name} record; stderr: ${this.stderr()}` });
    return found as T;
  }

  async state(): Promise<WorkerState | null> {
    const text = await readFile(join(this.ctrl, 'state.json'), 'utf8').catch(() => null);
    return text === null ? null : (JSON.parse(text) as WorkerState);
  }

  /**
   * The state file appears once the process reports its outcome. A sync record can be written *before* it (the sync
   * loop starts inside `startDaemon`), so every read that follows another signal waits for the file.
   */
  async waitForState(timeoutMs = 20_000): Promise<WorkerState> {
    await this.waitFor('state.json', timeoutMs, 'never reported its outcome');
    const state = await this.state();
    if (state === null) throw new Error(`worker (${this.spec.mode}, ${this.spec.home}): state.json is unreadable`);
    return state;
  }

  /** The exit code, or null while the process is still alive. */
  async exitWithin(timeoutMs: number): Promise<number | null> {
    const code = await Promise.race([this.exit, Bun.sleep(timeoutMs).then(() => null)]);
    if (code !== null) await Promise.all(this.drains);
    return code;
  }

  /** `kill -9` of this process: the OS drops its file locks, its job child keeps running. */
  killHard(): void {
    this.proc.kill('SIGKILL');
  }

  async stop(): Promise<void> {
    await this.write('stop', '');
    await this.proc.exited;
    await Promise.all(this.drains);
  }

  async kill(): Promise<void> {
    if (!this.exited) {
      this.proc.kill('SIGKILL');
      await Promise.race([this.exit, Bun.sleep(2_000)]);
    }
    for (const child of await this.records<{ pid: number }>('children')) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* the child is already gone */ }
    }
  }
}

interface Transport {
  readonly fetchFn: FetchFn;
  readonly syncs: SyncRequest[];
  queue(command: FleetCommandOut): void;
}

/** An in-process recording sync transport: /me, /sync, and nothing else. */
function recordingTransport(): Transport {
  const syncs: SyncRequest[] = [];
  const commands: FleetCommandOut[] = [];
  const acked = new Set<string>();
  const fetchFn: FetchFn = async (rawUrl, init) => {
    const path = new URL(String(rawUrl)).pathname;
    const reply = (data: unknown): Response => new Response(JSON.stringify({ ret: 0, data }), { status: 200 });
    if (path.endsWith('/me')) return reply({ id: 'r-home', name: 'home', labels: [], capacity: 2, enabled: true });
    if (!path.endsWith('/sync')) return new Response('not in this fixture', { status: 404 });
    const body = JSON.parse(String(init?.body)) as SyncRequest;
    syncs.push(body);
    for (const ack of body.commandAcks) acked.add(ack.commandId);
    const pending = commands.filter((command) => !acked.has(command.commandId));
    const jobAcks = body.jobs.flatMap((job) => {
      const last = job.events.at(-1);
      return last === undefined ? [] : [{ jobId: job.jobId, leaseEpoch: job.leaseEpoch, ackedSeq: last.seq }];
    });
    if (pending.length === 0 && jobAcks.length === 0) await Bun.sleep(20);
    return reply({ jobAcks, commands: pending, gitTokens: [], gitTokenErrors: [], unknownJobIds: [] });
  };
  return { fetchFn, syncs, queue: (command) => { commands.push(command); } };
}

async function loaded(home: Home): Promise<{ config: RunnerConfig; identity: RunnerIdentityFile }> {
  const config = await loadRunnerConfig(join(home.dir, 'runner.json'), {});
  const identity = await readIdentity(join(home.dir, 'identity.json'));
  if (!identity) throw new Error('the fixture home has no identity.json');
  return { config, identity };
}

async function daemonOptions(home: Home, transport: Transport, executor: FakeExecutor): Promise<DaemonOptions> {
  const { config, identity } = await loaded(home);
  return {
    home: resolveHome({}, home.dir), config, identity, fetchFn: transport.fetchFn,
    tuning: TUNING, log: createMemoryLogger(), executorFactory: () => executor,
  };
}

async function cli(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', MAIN, ...args], { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

/** The structured log lines a command wrote to stderr; a non-JSON line is not one of them. */
function logLines(stderr: string): Array<{ level?: string; msg?: string }> {
  return stderr.split('\n').filter((line) => line.startsWith('{'))
    .map((line) => { try { return JSON.parse(line) as { level?: string; msg?: string }; } catch { return {}; } });
}

const occupied = (home: string): string => `Runner home is already in use: ${home}`;

describe('US-001 ownership across daemon startup, recovery and shutdown', () => {
  test('AC-1: two runner processes released together against one idle home put exactly one boot id on POST /fleet/runner/sync', async () => {
    const home = await enrolledHome('ac1');
    const a = await HomeWorker.spawn({ mode: 'run', home: home.dir, workspaceRoot: home.workspaceRoot, socketDir: home.socketDir, naxHome: home.naxHome });
    const b = await HomeWorker.spawn({ mode: 'run', home: home.dir, workspaceRoot: home.workspaceRoot, socketDir: home.socketDir, naxHome: home.naxHome });
    try {
      await Promise.all([a.ready(), b.ready()]);
      await Promise.all([a.release(), b.release()]);   // released together against the same idle home
      const first = await Promise.race([
        a.exitWithin(20_000).then((code) => ({ worker: a, code })),
        b.exitWithin(20_000).then((code) => ({ worker: b, code })),
      ]);
      if (first.code === null) throw new Error('neither contender exited: the idle home accepted two runners');
      expect(first.code).toBe(1);
      const winner = first.worker === a ? b : a;
      await winner.waitForRecord<SyncEntry>('syncs', 20_000, (entry) => entry.path === '/api/fleet/runner/sync');
      const syncs = [...await a.records<SyncEntry>('syncs'), ...await b.records<SyncEntry>('syncs')]
        .filter((entry) => entry.method === 'POST' && entry.path === '/api/fleet/runner/sync');
      expect(syncs.length).toBeGreaterThan(0);
      expect([...new Set(syncs.map((entry) => entry.bootId))]).toHaveLength(1);
    } finally {
      await a.kill();
      await b.kill();
    }
  }, 40_000);

  test('AC-2: an independent writer holding daemon-lock.db makes run exit 1 within one second of the barrier', async () => {
    const home = await enrolledHome('ac2');
    const worker = await HomeWorker.spawn({ mode: 'run', home: home.dir, workspaceRoot: home.workspaceRoot, socketDir: home.socketDir, naxHome: home.naxHome });
    await worker.ready();
    const writer = await holdLockDatabase(home.dir);
    try {
      const started = performance.now();
      await worker.release();
      const code = await worker.exitWithin(3_000);
      const elapsed = performance.now() - started;
      expect(code).toBe(1);
      expect(elapsed).toBeLessThan(1_000);   // a busy-retry timeout would blow this bound
      expect(worker.stderr()).toContain(occupied(home.dir));
    } finally {
      writer.release();
      await worker.kill();
    }
  }, 40_000);

  test('AC-3: a relative --home naming a symlink to the occupied home is reported by its absolute spelling', async () => {
    const home = await enrolledHome('ac3');
    const writer = await holdLockDatabase(home.dir);
    try {
      await symlink(home.dir, join(home.base, 'runner-alias'));
      // The process's own working directory spelling, which is what "absolute spelling" means for its diagnostic.
      const cwd = await realpath(home.base);
      const run = await cli(['--home', 'runner-alias', 'run'], cwd);
      expect(run.code).toBe(1);
      const msg = logLines(run.stderr).find((line) => line.msg?.startsWith('Runner home is already in use'))?.msg;
      expect(msg).toBe(occupied(join(cwd, 'runner-alias')));
    } finally {
      writer.release();
    }
  }, 30_000);

  test('AC-4: a contender reaching startDaemon through a directory symlink attempts none of the protected startup', async () => {
    const home = await enrolledHome('ac4');
    const owner = await HomeWorker.spawn({ mode: 'daemon', home: home.dir, workspaceRoot: home.workspaceRoot, socketDir: home.socketDir, naxHome: home.naxHome });
    try {
      await owner.ready();
      await owner.release();
      await owner.waitForRecord<SyncEntry>('syncs', 20_000);
      const ownerState = await owner.waitForState();
      expect(ownerState).toMatchObject({ ok: true });
      // A runner.log the contender's own threshold (10 bytes) would rotate, and that the owner never touches.
      await writeFile(join(home.dir, 'runner.log'), 'x'.repeat(200));
      await symlink(home.dir, join(home.base, 'home-alias'));
      const contenderWorkspace = join(home.base, 'contender-ws');
      await mkdir(contenderWorkspace, { recursive: true });
      const contenderSocketDir = await shortSocketDir();
      const contender = await HomeWorker.spawn({
        mode: 'daemon', home: join(home.base, 'home-alias'), workspaceRoot: contenderWorkspace, socketDir: contenderSocketDir,
        naxHome: home.naxHome, tuning: { runnerLogMaxBytes: 10 },
      });
      try {
        await contender.ready();
        await contender.release();
        expect(await contender.exitWithin(20_000)).toBe(1);
        expect((await contender.waitForState()).error ?? '').toContain(occupied(join(home.base, 'home-alias')));
        // The protected startup event log, recorded by the contender itself: nothing was attempted.
        expect(await contender.records<AttemptEntry>('attempts')).toEqual([]);
        expect(existsSync(join(contenderWorkspace, '.jobs'))).toBe(false);
        expect(existsSync(contenderSocketDir)).toBe(false);
        expect(await readFile(join(home.dir, 'runner.log'), 'utf8')).toBe('x'.repeat(200));
        expect(existsSync(join(home.dir, 'runner.log.1'))).toBe(false);
        const journal = Journal.openReadOnly(join(home.dir, 'journal.db'));
        try {
          expect(journal.getMeta('boot_id')).toBe(ownerState?.bootId ?? null);
        } finally {
          journal.close();
        }
        // The contender's empty log only means something if the same instrumentation records an owner's startup:
        // retire the owner cleanly (its own probe runs as it exits) and look at what it recorded.
        await owner.stop();
        const ownerAttempts = (await owner.records<AttemptEntry>('attempts')).map((attempt) => attempt.name);
        expect(ownerAttempts).toEqual(expect.arrayContaining(['journal-open', 'workspace-jobs', 'socket-dir']));
      } finally {
        await contender.kill();
      }
    } finally {
      await owner.kill();
    }
  }, 60_000);

  test('AC-5: an ASSIGN still eligible for redelivery plus a paused owner and a contender yields exactly one launch', async () => {
    const home = await enrolledHome('ac5');
    const assign: FleetCommandOut = { commandId: 'c-assign', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1, payload: assignFor('RUN') };
    const a = await HomeWorker.spawn({ mode: 'daemon', home: home.dir, workspaceRoot: home.workspaceRoot, socketDir: home.socketDir, naxHome: home.naxHome, holdPrepare: true });
    await a.write('commands.json', [assign]);
    const b = await HomeWorker.spawn({
      mode: 'daemon', home: home.dir, workspaceRoot: join(home.base, 'b-ws'), socketDir: await shortSocketDir(), naxHome: home.naxHome,
    });
    try {
      await b.write('commands.json', [assign]);   // a contender would receive the same ASSIGN, so its ack is held too
      await a.ready();
      await a.release();
      await a.waitFor('prepare-held', 20_000, 'never paused before recording a worker pid');
      await b.ready();
      await b.release();                          // B needs no sync or preparation barrier
      expect(await b.exitWithin(20_000)).toBe(1);
      expect((await b.waitForState()).ok).toBe(false);
      await a.write('prepare-release', '');       // release A's preparation directly,
      await a.write('acked.json', [assign.commandId]);   // and its held acknowledgement
      await a.waitForRecord<LaunchEntry>('launches', 20_000);
      const launches = [...await a.records<LaunchEntry>('launches'), ...await b.records<LaunchEntry>('launches')]
        .filter((entry) => entry.jobId === 'j1' && entry.leaseEpoch === 1);
      expect(launches).toHaveLength(1);
    } finally {
      await a.kill();
      await b.kill();
    }
  }, 60_000);

  test('AC-6: two independent homes with separate runner resources each reach sync while the other process is alive', async () => {
    const one = await enrolledHome('ac6a');
    const two = await enrolledHome('ac6b');
    const a = await HomeWorker.spawn({ mode: 'daemon', home: one.dir, workspaceRoot: one.workspaceRoot, socketDir: one.socketDir, naxHome: one.naxHome });
    const b = await HomeWorker.spawn({ mode: 'daemon', home: two.dir, workspaceRoot: two.workspaceRoot, socketDir: two.socketDir, naxHome: two.naxHome });
    try {
      await Promise.all([a.ready(), b.ready()]);
      await Promise.all([a.release(), b.release()]);
      await Promise.all([
        a.waitForRecord<SyncEntry>('syncs', 20_000, (entry) => entry.path === '/api/fleet/runner/sync'),
        b.waitForRecord<SyncEntry>('syncs', 20_000, (entry) => entry.path === '/api/fleet/runner/sync'),
      ]);
      expect(a.gone).toBe(false);
      expect(b.gone).toBe(false);
      expect((await a.waitForState()).ok).toBe(true);
      expect((await b.waitForState()).ok).toBe(true);
      // The new path: each independent home holds its own ownership interval.
      expect([existsSync(join(one.dir, RUNNER_HOME_LOCK_FILE)), existsSync(join(two.dir, RUNNER_HOME_LOCK_FILE))]).toEqual([true, true]);
    } finally {
      await a.kill();
      await b.kill();
    }
  }, 40_000);

  test('AC-7: status --json reports the job id the live owner holds in the journal', async () => {
    const home = await enrolledHome('ac7');
    const owner = await HomeWorker.spawn({ mode: 'daemon', home: home.dir, workspaceRoot: home.workspaceRoot, socketDir: home.socketDir, naxHome: home.naxHome });
    try {
      await owner.write('commands.json', [{ commandId: 'c-assign', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1, payload: assignFor('RUN') }]);
      await owner.ready();
      await owner.release();
      await owner.waitForRecord<LaunchEntry>('launches', 20_000);
      const status = await cli(['--home', home.dir, 'status', '--json'], home.base);
      expect(status.code).toBe(0);
      const report = JSON.parse(status.stdout) as { journal?: { jobs?: Array<{ jobId: string }> } };
      expect(report.journal?.jobs?.map((job) => job.jobId)).toContain('j1');
      // The owner that holds this journal also holds the home.
      expect(existsSync(join(home.dir, RUNNER_HOME_LOCK_FILE))).toBe(true);
    } finally {
      await owner.kill();
    }
  }, 40_000);

  test('AC-8: while stop() waits for a held journal writer, a second run receives the occupied-home failure', async () => {
    const home = await enrolledHome('ac8');
    const transport = recordingTransport();
    const executor = new FakeExecutor();
    let preparing = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    executor.prepare = async () => {
      preparing = true;
      await gate;
      return { ok: true, branch: 'feat/home' };
    };
    const daemon = await startDaemon(await daemonOptions(home, transport, executor));
    let stopping: Promise<void> | null = null;
    try {
      transport.queue({ commandId: 'c-assign', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1, payload: assignFor('RUN') });
      await waitFor(() => preparing);
      stopping = daemon.stop();          // the held journal writer keeps the retirement open
      await Bun.sleep(50);
      expect(daemon.journal.getJob('j1', 1)).not.toBeNull();
      const log: MemoryLogger = createMemoryLogger();
      const code = await runCommand(home.dir, { env: {}, log, start: startDaemon, onSignal: () => undefined });
      expect(code).toBe(1);
      expect(log.lines.some((line) => line.level === 'error' && line.message === occupied(home.dir))).toBe(true);
    } finally {
      release();
      if (stopping) await stopping;
      else await daemon.stop();
    }
  }, 30_000);

  test('AC-9: after stop() resolves the replacement owner reads the previously persisted jobId from the same journal', async () => {
    const home = await enrolledHome('ac9');
    const firstTransport = recordingTransport();
    const firstExecutor = new FakeExecutor();
    const first = await startDaemon(await daemonOptions(home, firstTransport, firstExecutor));
    let second: DaemonHandle | null = null;
    try {
      firstTransport.queue({ commandId: 'c-assign', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1, payload: assignFor('RUN') });
      await waitFor(() => {
        const row = first.journal.getJob('j1', 1);
        return row !== null && row.pid !== null;
      });
    } finally {
      firstExecutor.alive = false;
      await first.stop();
    }
    second = await startDaemon(await daemonOptions(home, recordingTransport(), new FakeExecutor()));
    try {
      expect(second.journal.getJob('j1', 1)?.jobId).toBe('j1');
      // The replacement owns the home again: this start could only resolve because the first stop released it.
      expect(existsSync(join(home.dir, RUNNER_HOME_LOCK_FILE))).toBe(true);
    } finally {
      await second.stop();
    }
  }, 30_000);

  test('AC-10: a replacement starts on the same home after the owner is killed with its job child still alive', async () => {
    const home = await enrolledHome('ac10');
    const owner = await HomeWorker.spawn({
      mode: 'daemon', home: home.dir, workspaceRoot: home.workspaceRoot, socketDir: home.socketDir, naxHome: home.naxHome, spawnInertChild: true,
    });
    const replacement = await HomeWorker.spawn({
      mode: 'daemon', home: home.dir, workspaceRoot: join(home.base, 'r-ws'), socketDir: await shortSocketDir(), naxHome: home.naxHome,
    });
    try {
      await owner.write('commands.json', [{ commandId: 'c-assign', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1, payload: assignFor('RUN') }]);
      await owner.ready();
      await owner.release();
      const child = await owner.waitForRecord<{ pid: number }>('children', 20_000);
      owner.killHard();                        // the owning OS process dies outright
      expect(await owner.exitWithin(10_000)).not.toBeNull();
      expect(isRunning(child.pid)).toBe(true);  // the job child outlives it
      await replacement.ready();
      await replacement.release();
      await replacement.waitForRecord<SyncEntry>('syncs', 20_000, (entry) => entry.path === '/api/fleet/runner/sync');
      expect((await replacement.waitForState()).ok).toBe(true);
      expect(existsSync(join(home.dir, RUNNER_HOME_LOCK_FILE))).toBe(true);
    } finally {
      await owner.kill();
      await replacement.kill();
    }
  }, 60_000);

  test('AC-11: after startDaemon fails its capability probe, a fresh caller syncs on the same home while the first caller lives', async () => {
    const home = await enrolledHome('ac11', { naxMode: true });
    const failing = await HomeWorker.spawn({
      mode: 'daemon', home: home.dir, workspaceRoot: home.workspaceRoot, socketDir: home.socketDir, naxHome: home.naxHome,
      naxMode: true, naxCommand: ['bun', FAKE_NAX], holdAfterFailure: true, env: { FAKE_NAX_VERSION: '0.83.0' },
    });
    const fresh = await HomeWorker.spawn({
      mode: 'daemon', home: home.dir, workspaceRoot: join(home.base, 'fresh-ws'), socketDir: await shortSocketDir(), naxHome: home.naxHome,
      naxMode: true, naxCommand: ['bun', FAKE_NAX], env: { FAKE_NAX_VERSION: '0.83.1-fake' },
    });
    try {
      await failing.ready();
      await failing.release();
      expect(await failing.waitForState()).toMatchObject({ ok: false });
      expect(failing.gone).toBe(false);        // the original caller process is still alive
      await fresh.ready();
      await fresh.release();
      await fresh.waitForRecord<SyncEntry>('syncs', 20_000, (entry) => entry.path === '/api/fleet/runner/sync');
      expect((await fresh.waitForState()).ok).toBe(true);
      // The failed start had acquired the home (it writes the lock database) and handed it back.
      expect(existsSync(join(home.dir, RUNNER_HOME_LOCK_FILE))).toBe(true);
    } finally {
      await failing.kill();
      await fresh.kill();
    }
  }, 60_000);

  test('AC-12: an unusable lock path makes the run command exit 1', async () => {
    const fixtures = await lockPathFixtures();
    // Named so a silently dropped fixture fails here instead of passing with less coverage than the AC asks for.
    expect(fixtures.map((fixture) => fixture.kind)).toEqual(IS_ROOT ? ['directory'] : ['directory', 'unreadable']);
    for (const fixture of fixtures) {
      const run = await cli(['--home', fixture.home.dir, 'run'], fixture.home.base);
      expect({ fixture: fixture.kind, code: run.code }).toEqual({ fixture: fixture.kind, code: 1 });
    }
  }, 40_000);

  test('AC-13: the startup diagnostic of an unusable lock path names the full path to daemon-lock.db', async () => {
    const fixtures = await lockPathFixtures();
    expect(fixtures.map((fixture) => fixture.kind)).toEqual(IS_ROOT ? ['directory'] : ['directory', 'unreadable']);
    for (const fixture of fixtures) {
      const run = await cli(['--home', fixture.home.dir, 'run'], fixture.home.base);
      const lockPath = join(fixture.home.dir, RUNNER_HOME_LOCK_FILE);
      const startup = logLines(run.stderr).filter((line) => line.level === 'error').map((line) => line.msg ?? '');
      expect({ fixture: fixture.kind, named: startup.some((msg) => msg.includes(lockPath)) }).toEqual({ fixture: fixture.kind, named: true });
    }
  }, 40_000);

  test('AC-14: after the in-process crash() stand-in retires an owner, a replacement startDaemon resolves', async () => {
    const home = await enrolledHome('ac14');
    const first = await startDaemon(await daemonOptions(home, recordingTransport(), new FakeExecutor()));
    first.crash();
    const replacement = await startDaemon(await daemonOptions(home, recordingTransport(), new FakeExecutor()));
    try {
      expect(replacement.bootId).not.toBe(first.bootId);
      expect(replacement.journal.getMeta('boot_id')).toBe(replacement.bootId);
      // Only the crash stand-in's release lets this replacement own the home.
      expect(existsSync(join(home.dir, RUNNER_HOME_LOCK_FILE))).toBe(true);
    } finally {
      await replacement.stop();
    }
  }, 30_000);

  test('F1: a startup failure after the writable journal opens closes it, then hands the home back', async () => {
    const home = await enrolledHome('f1');
    // A failure after Journal.open: sweeping an orphan job profile that is a directory cannot remove it.
    await mkdir(join(home.naxHome, 'profiles', 'koda-job-orphan.json'), { recursive: true });
    const opened: Journal[] = [];
    const transport = recordingTransport();
    const realOpen = Journal.open;
    Journal.open = ((path: string, now?: Parameters<typeof Journal.open>[1]) => {
      const journal = realOpen(path, now);
      opened.push(journal);
      return journal;
    }) as typeof Journal.open;
    let failure: unknown;
    try {
      failure = await startDaemon(await daemonOptions(home, transport, new FakeExecutor()))
        .then(() => null, (error: unknown) => error);
    } finally {
      Journal.open = realOpen;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/EISDIR|is a directory/i);
    // The attempt had opened the writable journal before it failed: the entry point retires that connection before it
    // releases the home, so no resource of the failed start is still open on the home a replacement takes.
    expect(opened).toHaveLength(1);
    expect(() => opened[0]?.getJob('j1', 1)).toThrow();
    expect(transport.syncs).toEqual([]);   // it never reached sync either
    await rm(join(home.naxHome, 'profiles', 'koda-job-orphan.json'), { recursive: true, force: true });
    const replacement = await startDaemon(await daemonOptions(home, recordingTransport(), new FakeExecutor()));
    try {
      expect(replacement.bootId).toBeTruthy();
      expect(replacement.journal.getMeta('boot_id')).toBe(replacement.bootId);
    } finally {
      await replacement.stop();
    }
  }, 30_000);

  test('AC-15: a repeated stop() on a retired handle leaves the newer owner in place for a third contender', async () => {
    const home = await enrolledHome('ac15');
    const first = await startDaemon(await daemonOptions(home, recordingTransport(), new FakeExecutor()));
    await first.stop();
    const second = await startDaemon(await daemonOptions(home, recordingTransport(), new FakeExecutor()));
    try {
      await first.stop();   // repeating the retired handle's stop must not release the successor
      const contender = await startDaemon(await daemonOptions(home, recordingTransport(), new FakeExecutor()))
        .then(() => null, (error: unknown) => error);
      expect(contender).toBeInstanceOf(HomeOwnershipError);
      expect(contender).toMatchObject({ kind: 'occupied', message: occupied(home.dir) });
      expect(second.journal.getMeta('boot_id')).toBe(second.bootId);
    } finally {
      await second.stop();
    }
  }, 30_000);
});

/** The two unusable lock-path fixtures: a directory in the way, and a lock database the process cannot open. */
async function lockPathFixtures(): Promise<Array<{ kind: string; home: Home }>> {
  const blocked = await enrolledHome('ac12-dir');
  await mkdir(join(blocked.dir, RUNNER_HOME_LOCK_FILE), { recursive: true });
  const fixtures = [{ kind: 'directory', home: blocked }];
  if (IS_ROOT) return fixtures;   // root opens a 0o000 file, so that fixture says nothing here
  const unreadable = await enrolledHome('ac12-perm');
  const lockPath = join(unreadable.dir, RUNNER_HOME_LOCK_FILE);
  await writeFile(lockPath, '');
  await chmod(lockPath, 0o000);
  fixtures.push({ kind: 'unreadable', home: unreadable });
  return fixtures;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

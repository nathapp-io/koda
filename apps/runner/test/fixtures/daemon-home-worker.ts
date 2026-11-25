/**
 * US-001: one runner process of the home-ownership spec (`test/unit/daemon-home-ownership.spec.ts`).
 *
 * The controller (the spec) writes `<ctrlDir>/spec.json` and from then on talks to the process through files only:
 * it drops `<go>` to release the attempt, `<prepare-release>` to let a held preparation finish, `<acked.json>` to
 * release a held acknowledgement, and `<stop>` to retire a daemon. The process answers with `<ready>` (written after
 * its Git preflight, immediately before the ownership attempt), `<state.json>` and one JSON line per event in
 * `syncs.jsonl` (the recording sync transport), `command-acks.jsonl`, `launches.jsonl`, `children.jsonl`,
 * `phases.jsonl` and `attempts.jsonl` (the protected startup side effects it observed itself).
 *
 * Two modes:
 * - `run`    — `runCommand`, exactly as `koda-runner run` calls it, with `startDaemon` as its start.
 * - `daemon` — `startDaemon` directly with local collaborators: an inert executor and a recording sync transport,
 *              and a static runner.json capabilities block, so nothing on the host (nax, gh, a remote) is touched.
 *
 * Instrumentation never counts the owner's activity: every record is written by the contender process itself.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SyncRequest } from '@nathapp/fleet-protocol';
import { runCommand } from '../../src/commands/run';
import { parseRunnerConfig, resolveHome } from '../../src/config/runner-config';
import { startDaemon, type DaemonHandle } from '../../src/daemon/daemon';
import type { Tuning } from '../../src/daemon/tuning';
import { errorMessage } from '../../src/errors';
import { assertMinGitVersion, createGit } from '../../src/executor/git';
import { Journal } from '../../src/journal/journal';
import { createConsoleLogger } from '../../src/logger';
import type { FetchFn } from '../../src/sync/http';
import { FakeExecutor } from '../helpers/fake-executor';

const GATE_MS = 60_000;
const STOP_MS = 300_000;

export interface HomeWorkerSpec {
  readonly mode: 'run' | 'daemon';
  /** The home as this process spells it: `run` mode resolves it from the spelling the caller gave. */
  readonly home: string;
  readonly ctrlDir: string;
  readonly serverUrl: string;
  readonly runnerId: string;
  /** daemon mode: the config it builds (run mode reads the same values from the home's runner.json). */
  readonly workspaceRoot: string;
  readonly socketDir: string;
  readonly naxHome: string;
  /** daemon mode: no capabilities block, so the daemon probes nax (`naxCommand` must be the fake nax). */
  readonly naxMode?: boolean;
  readonly naxCommand?: readonly string[];
  readonly tuning?: Partial<Tuning>;
  readonly bootId?: string;
  /** daemon mode: the executor holds `prepare` until `<ctrlDir>/prepare-release`. */
  readonly holdPrepare?: boolean;
  /** daemon mode: the executor launches a real child, so it outlives a killed daemon. */
  readonly spawnInertChild?: boolean;
  /** Stay alive after a failed start, so the controller can start a replacement while this caller lives. */
  readonly holdAfterFailure?: boolean;
}

export interface WorkerState {
  readonly ok: boolean;
  readonly code: number;
  readonly bootId?: string;
  readonly error?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function waitForFile(path: string, timeoutMs = GATE_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await sleep(5);
  }
  return false;
}

/** The recording sync transport: every request it answers is one line of `syncs.jsonl`. */
function fileTransport(spec: HomeWorkerSpec, record: (name: string, entry: unknown) => void): FetchFn {
  const ctrl = spec.ctrlDir;
  return async (rawUrl, init) => {
    const path = new URL(String(rawUrl)).pathname;
    const reply = (data: unknown): Response => Response.json({ ret: 0, data });
    if (path.endsWith('/me')) return reply({ id: spec.runnerId, name: 'home', labels: [], capacity: 2, enabled: true });
    if (!path.endsWith('/sync')) return new Response('not in this fixture', { status: 404 });
    const body = JSON.parse(String(init?.body)) as SyncRequest;
    record('syncs', { method: 'POST', path, bootId: body.bootId });
    for (const ack of body.commandAcks) record('command-acks', ack);
    // The command ids the controller released. The daemon's own acks are recorded above and never release a hold:
    // an ASSIGN stays eligible for redelivery until the controller says otherwise.
    const released = readJson<readonly string[]>(join(ctrl, 'acked.json')) ?? [];
    const commands = (readJson<readonly { commandId: string }[]>(join(ctrl, 'commands.json')) ?? [])
      .filter((command) => !released.includes(command.commandId));
    const jobAcks = body.jobs.flatMap((job) => {
      const last = job.events.at(-1);
      return last === undefined ? [] : [{ jobId: job.jobId, leaseEpoch: job.leaseEpoch, ackedSeq: last.seq }];
    });
    if (commands.length === 0 && jobAcks.length === 0) await sleep(15);
    return reply({ jobAcks, commands, gitTokens: [], gitTokenErrors: [], unknownJobIds: [] });
  };
}

/** This process's daemon config: the controller's values, plus the capability mode it asked for. */
function daemonConfig(spec: HomeWorkerSpec) {
  return parseRunnerConfig({
    serverUrl: spec.serverUrl, workspaceRoot: spec.workspaceRoot, naxHome: spec.naxHome, socketDir: spec.socketDir, jobRetentionDays: 1,
    naxCommand: [...(spec.naxCommand ?? ['nax'])],
    ...(spec.naxMode === true ? {} : {
      capabilities: {
        nax: { version: '0.83.1', protocols: ['native'] }, sandbox: { available: true },
        profiles: {}, credentials: [], tools: { git: true, gh: false, glab: false }, executors: ['host'],
      },
    }),
  }, {});
}

async function runMode(
  spec: HomeWorkerSpec, record: (name: string, entry: unknown) => void, writeState: (state: WorkerState) => Promise<void>,
): Promise<number> {
  // `koda-runner run` builds its own `ServerClient`, whose transport is the global fetch: this is where the
  // recording sync transport of a CLI-shaped worker is installed.
  const transport = fileTransport(spec, record);
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => transport(String(input), init)) as typeof fetch;
  const code = await runCommand(spec.home, {
    env: process.env, log: createConsoleLogger(), start: startDaemon,
    onSignal: (signal, handler) => { process.on(signal, handler); },
  });
  await writeState({ ok: code === 0, code });
  return code;
}

async function daemonMode(
  spec: HomeWorkerSpec, record: (name: string, entry: unknown) => void, writeState: (state: WorkerState) => Promise<void>,
): Promise<number> {
  const config = daemonConfig(spec);
  const identity = {
    runnerId: spec.runnerId, apiKey: 'kr_home_ownership', serverUrl: spec.serverUrl, name: 'home', enrolledAt: '2026-01-01T00:00:00.000Z',
  };
  const executor = new FakeExecutor();
  let child: Bun.Subprocess<'ignore', 'ignore', 'ignore'> | null = null;
  let childPid: number | null = null;
  executor.prepare = async () => {
    record('phases', { name: 'prepare' });
    if (spec.holdPrepare === true) {
      await writeFile(join(spec.ctrlDir, 'prepare-held'), '');
      await waitForFile(join(spec.ctrlDir, 'prepare-release'));
    }
    return { ok: true, branch: 'feat/home' };
  };
  executor.spawn = async (row) => {
    record('launches', { jobId: row.jobId, leaseEpoch: row.leaseEpoch, daemonPid: process.pid });
    if (childPid === null && spec.spawnInertChild === true) {
      // Its own stdio and no signals from the controller's side: it outlives a daemon that is killed outright.
      child = Bun.spawn(['sleep', '60'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
      childPid = child.pid;
      record('children', { pid: childPid, jobId: row.jobId });
    }
    executor.alive = true;   // the job stays RUNNING for the length of the test
    const pid = child?.pid ?? process.pid;
    return { pid, pgid: pid };
  };
  let daemon: DaemonHandle;
  try {
    daemon = await startDaemon({
      home: resolveHome({}, spec.home),
      config, identity, fetchFn: fileTransport(spec, record), tuning: spec.tuning, log: createConsoleLogger(),
      executorFactory: () => executor, selfCommand: [process.execPath, '--help'], configureCredentials: () => undefined,
      ...(spec.bootId === undefined ? {} : { bootId: spec.bootId }),
    });
  } catch (error) {
    const message = errorMessage(error);
    record('phases', { name: 'failed', error: message });
    await writeState({ ok: false, code: 1, error: message });
    if (spec.holdAfterFailure === true) await waitForFile(join(spec.ctrlDir, 'stop'));
    return 1;
  }
  record('phases', { name: 'owned', bootId: daemon.bootId });
  await writeState({ ok: true, code: 0, bootId: daemon.bootId });
  await waitForFile(join(spec.ctrlDir, 'stop'), STOP_MS);
  executor.alive = false;   // the held run ends, so the stop does not wait for it
  await daemon.stop();
  await writeState({ ok: true, code: 0, bootId: daemon.bootId });
  killQuietly(childPid);
  return 0;
}

function killQuietly(pid: number | null): void {
  if (pid === null) return;
  try { process.kill(pid, 'SIGKILL'); } catch { /* the child is already gone */ }
}

interface LogSnapshot {
  readonly size: number;
  readonly rotated: boolean;
}

/** The runner.log a rotation attempt would touch, as it stood before the attempt. */
async function logSnapshot(home: string): Promise<LogSnapshot> {
  const path = join(resolve(home), 'runner.log');
  const info = await stat(path).catch(() => null);
  return { size: info?.size ?? 0, rotated: existsSync(`${path}.1`) };
}

/**
 * The protected startup side effects this process can observe from the outside. Each record is named for the item
 * AC-4 lists; a guarded start leaves `attempts.jsonl` empty. The other two items (a writable `Journal.open` and sync)
 * are recorded as they are attempted, from inside this process.
 */
async function probeAttempts(spec: HomeWorkerSpec, record: (name: string, entry: unknown) => void, before: LogSnapshot): Promise<void> {
  const jobs = join(spec.workspaceRoot, '.jobs');
  if (existsSync(jobs)) record('attempts', { name: 'workspace-jobs', path: jobs });
  if (existsSync(spec.socketDir)) record('attempts', { name: 'socket-dir', path: spec.socketDir });
  const logPath = join(resolve(spec.home), 'runner.log');
  const after = await stat(logPath).catch(() => null);
  if (existsSync(`${logPath}.1`) !== before.rotated || (after?.size ?? 0) < before.size) {
    record('attempts', { name: 'runner-log', path: logPath });
  }
}

/** Both protected items this process can see from inside are recorded as they are attempted. */
function instrument(record: (name: string, entry: unknown) => void): void {
  const open = Journal.open.bind(Journal);
  Journal.open = ((path: string, now?: Parameters<typeof Journal.open>[1]) => {
    record('attempts', { name: 'journal-open', path });
    return open(path, now);
  }) as typeof Journal.open;
}

export async function runWorker(specPath: string): Promise<number> {
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as HomeWorkerSpec;
  const record = (name: string, entry: unknown): void => {
    appendFileSync(join(spec.ctrlDir, `${name}.jsonl`), `${JSON.stringify(entry)}\n`);
  };
  const writeState = async (state: WorkerState): Promise<void> => {
    await writeFile(join(spec.ctrlDir, 'state.json'), JSON.stringify(state));
  };
  instrument(record);
  // The readiness point: after this process's Git preflight, immediately before the ownership attempt.
  await assertMinGitVersion(createGit());
  const before = await logSnapshot(spec.home);
  await writeFile(join(spec.ctrlDir, 'ready'), '');
  if (!(await waitForFile(join(spec.ctrlDir, 'go')))) {
    await writeState({ ok: false, code: 1, error: 'the controller never released the attempt' });
    return 1;
  }
  let code: number;
  try {
    code = spec.mode === 'run' ? await runMode(spec, record, writeState) : await daemonMode(spec, record, writeState);
  } catch (error) {
    await writeState({ ok: false, code: 1, error: errorMessage(error) });
    code = 1;
  }
  await probeAttempts(spec, record, before);
  return code;
}

if (import.meta.main) {
  const specPath = process.argv[2];
  if (!specPath) {
    process.stderr.write('usage: bun daemon-home-worker.ts <spec.json>\n');
    process.exit(2);
  }
  process.exit(await runWorker(specPath));
}

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSession } from '@nathapp/nax-agent';
import type { AssignPayload, FleetCommandOut, SyncRequest, SyncResponse, ThreadAssign } from '@nathapp/fleet-protocol';
import { parseRunnerConfig, resolveHome } from '../../src/config/runner-config';
import { startDaemon, type DaemonHandle, type DaemonOptions } from '../../src/daemon/daemon';
import { Journal } from '../../src/journal/journal';
import { createMemoryLogger } from '../../src/logger';
import type { FetchFn } from '../../src/sync/http';
import { FakeExecutor } from '../helpers/fake-executor';
import { FakeNaxCli } from '../helpers/fake-nax-cli';
import { isolateGit, makeOrigin } from '../helpers/git-fixture';
import { makeTempDirs } from '../helpers/tmp';
import { waitFor } from '../helpers/wait';

beforeAll(() => isolateGit());
const tmp = makeTempDirs();
const socketDirs: string[] = [];
afterAll(async () => {
  await Promise.all([tmp.cleanup(), ...socketDirs.map((path) => rm(path, { recursive: true, force: true }))]);
});

/**
 * Fleet S5a US-007 integration: `startDaemon` in nax mode over an injected fetch (never a listening server),
 * a real `file://` clone, a fake session factory and a fake nax. `socketDir` is a fresh directory directly under
 * `tmpdir()`: the runner refuses a socket path longer than a unix `sun_path`, and a deeper per-test directory
 * under a long TMPDIR would cross that bound.
 */
const makeSocketDir = (): Promise<string> => mkdtemp(`${tmpdir()}/`);

interface FakeFleet {
  readonly fetchFn: FetchFn;
  readonly syncs: SyncRequest[];
  readonly logPuts: Array<{ path: string; body: string }>;
  readonly queue: FleetCommandOut[];
  archivedThreadIds: string[] | undefined;
}

function fakeFleet(): FakeFleet {
  const fleet = { syncs: [], logPuts: [], queue: [], archivedThreadIds: undefined } as unknown as FakeFleet;
  const fetchFn: FetchFn = async (url, init) => {
    const target = new URL(url);
    const envelope = (data: unknown) => new Response(JSON.stringify({ ret: 0, data }));
    if (target.pathname.endsWith('/me')) return envelope({ id: 'r1', name: 'box', labels: [], capacity: 2, enabled: true });
    if (target.pathname.endsWith('/sync')) {
      const body = JSON.parse(String(init?.body)) as SyncRequest;
      fleet.syncs.push(body);
      const tokens = body.tokenRequests.map((request) => ({
        jobId: request.jobId, token: 'tok', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), username: 'x-access-token' as const,
      }));
      const commands = fleet.queue.splice(0);
      const response: SyncResponse = {
        jobAcks: body.jobs.map((job) => ({ jobId: job.jobId, ackedSeq: job.events.at(-1)?.seq ?? 0 })),
        commands, gitTokens: tokens, gitTokenErrors: [], unknownJobIds: [],
        ...(fleet.archivedThreadIds === undefined ? {} : { archivedThreadIds: fleet.archivedThreadIds }),
      };
      return envelope(response);
    }
    if (target.pathname.includes('/logs/')) {
      const bytes = Buffer.from(await new Response(init?.body).arrayBuffer());
      fleet.logPuts.push({ path: target.pathname, body: bytes.toString('utf8') });
      return envelope({ outcome: target.searchParams.has('final') ? 'complete' : 'appended', size: bytes.length });
    }
    return envelope({});
  };
  return Object.assign(fleet, { fetchFn });
}

function threadAssign(jobId: string, over: Partial<ThreadAssign> = {}): AssignPayload {
  return {
    jobId, command: 'THREAD',
    repo: { provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: 'file:///placeholder' },
    ref: 'main', feature: 'thread-job', planFrom: null, profiles: [], maxCostUsd: '5', bashMode: 'raw', approvalTimeoutSec: 600,
    gitIdentity: { name: 'koda-fleet[bot]', email: 'koda-fleet[bot]@users.noreply.github.com' },
    thread: {
      threadId: 't1', action: 'SESSION', feature: 'brainstorm-x', resume: false, instructions: 'be helpful',
      backend: { kind: 'native', model: 'minimax/MiniMax-M3' }, skills: [], initialMessage: { messageId: 'm1', text: 'hi' }, ...over,
    },
  };
}

/** A scripted session: the first turn completes at once, so the run goes RUNNING and stays there. */
function fakeSession(): AgentSession {
  return {
    id: 'session-1', backend: { kind: 'native' }, lastTurn: undefined,
    // `send` answers an async iterable directly, as nax-agent's session does.
    send: () => (async function* () { yield { type: 'turn_end', status: 'completed' }; })(),
    answer: () => 'accepted', cancel: () => undefined, close: async () => undefined,
  } as unknown as AgentSession;
}

async function fixture() {
  const base = await tmp.make('daemon-thread');
  const naxHome = join(base, 'naxhome');
  const workspaceRoot = join(base, 'ws');
  await mkdir(naxHome);
  await mkdir(workspaceRoot);
  await writeFile(join(naxHome, 'config.json'), JSON.stringify({ models: { native: { balanced: 'minimax/MiniMax-M3' } } }));
  const origin = await makeOrigin(base, 'origin', { files: { 'README.md': 'hello\n' } });
  const home = resolveHome({}, join(base, 'home'));
  const socketDir = await makeSocketDir();
  socketDirs.push(socketDir);
  const config = parseRunnerConfig({ serverUrl: 'http://127.0.0.1:9', workspaceRoot, naxHome, socketDir, jobRetentionDays: 1 }, {});
  const fleet = fakeFleet();
  const executor = new FakeExecutor();
  const sessions: NonNullable<DaemonOptions['threadSessions']> = { open: async () => ({ ok: true, session: fakeSession(), resumed: false }) };
  const start = (over: Partial<DaemonOptions> = {}): Promise<DaemonHandle> => startDaemon({
    home, config, identity: { runnerId: 'r1', apiKey: 'kr_test', serverUrl: config.serverUrl, name: 'box', enrolledAt: '2026-10-01T00:00:00.000Z' },
    fetchFn: fleet.fetchFn, nax: new FakeNaxCli({ version: '0.86.0', auth: [{ providerId: 'minimax', available: true, stored: null, ambient: true }] }),
    executorFactory: () => executor, log: createMemoryLogger(),
    selfCommand: [process.execPath, join(import.meta.dir, '../../src/main.ts')],
    tuning: { syncMinGapMs: 10, statusPollMs: 10, pruneIntervalMs: 50 },
    threadSessions: sessions,
    ...over,
  });
  /** A THREAD assign for the fixture's own `file://` clone: no network leaves the machine. */
  const assign = (jobId: string, over: Partial<ThreadAssign> = {}): AssignPayload => {
    const payload = threadAssign(jobId, over);
    return { ...payload, repo: { ...payload.repo, cloneUrl: origin.url } };
  };
  /** A row the daemon finds already live: it counts as an active THREAD job without a session in memory. */
  const seedRunningThread = async (over: Partial<ThreadAssign> = {}): Promise<void> => {
    await mkdir(home.dir, { recursive: true });
    const payload = assign('seed', over);
    const journal = Journal.open(home.journalPath);
    journal.insertJob({ assign: payload, leaseEpoch: 1, repoKey: 'acme/app', jobDir: join(workspaceRoot, '.jobs', payload.jobId) });
    journal.updateJob(payload.jobId, 1, { state: 'RUNNING' });
    journal.close();
  };
  const daemon = (over: Partial<DaemonOptions> = {}): Promise<DaemonHandle> => start(over);
  return { home, config, fleet, daemon, assign, seedRunningThread };
}

describe('startDaemon thread wiring (US-007)', () => {
  test('AC-1: nax mode configures nax-agent credentials once, for the runner\'s nax home', async () => {
    const f = await fixture();
    const calls: Array<{ configDir(): string }> = [];
    const daemon = await f.daemon({ configureCredentials: (config) => { calls.push(config); } });
    try {
      expect(calls).toHaveLength(1);
      expect(calls[0].configDir()).toBe(f.config.naxHome);
    } finally {
      await daemon.stop();
    }
  });

  test('AC-2: the first sync reports the available native thread backend', async () => {
    const f = await fixture();
    const daemon = await f.daemon();
    try {
      await waitFor(() => f.fleet.syncs.length >= 1);
      expect(f.fleet.syncs[0].capabilities?.threadBackends).toEqual({ native: ['minimax/MiniMax-M3'], acp: [] });
    } finally {
      await daemon.stop();
    }
  });

  test('AC-12: the first sync speaks protocol 4', async () => {
    const f = await fixture();
    const daemon = await f.daemon();
    try {
      await waitFor(() => f.fleet.syncs.length >= 1);
      expect(f.fleet.syncs[0].protocolVersion).toBe(4);
    } finally {
      await daemon.stop();
    }
  });

  test('AC-3: a THREAD ASSIGN reaches the server as a thread log stream that starts with session_started', async () => {
    const f = await fixture();
    const daemon = await f.daemon();
    try {
      await waitFor(() => f.fleet.syncs.length >= 1);
      f.fleet.queue.push({ commandId: 'c1', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1, payload: f.assign('j1') });
      await waitFor(() => f.fleet.logPuts.some((put) => put.path.endsWith('/jobs/j1/logs/thread')), { timeoutMs: 20_000 });
      const put = f.fleet.logPuts.find((entry) => entry.path.endsWith('/jobs/j1/logs/thread'));
      expect(JSON.parse(put?.body.split('\n')[0] ?? '{}').type).toBe('session_started');
      expect(daemon.journal.getJob('j1', 1)?.state).toBe('RUNNING');
    } finally {
      await daemon.stop();
    }
  });

  test('AC-4: a RUNNING THREAD job consumes no nax slot', async () => {
    const f = await fixture();
    await f.seedRunningThread();
    const daemon = await f.daemon();
    try {
      await waitFor(() => f.fleet.syncs.length >= 1);
      expect(f.fleet.syncs[0].freeSlots).toBe(2);
    } finally {
      await daemon.stop();
    }
  });

  test('AC-7: the prune pass removes an archived thread directory', async () => {
    const f = await fixture();
    await mkdir(join(f.home.dir, 'threads', 't9'), { recursive: true });
    const daemon = await f.daemon();
    try {
      await waitFor(() => f.fleet.syncs.length >= 1);
      f.fleet.archivedThreadIds = ['t9'];
      await waitFor(() => !existsSync(join(f.home.dir, 'threads', 't9')), { timeoutMs: 10_000 });
    } finally {
      await daemon.stop();
    }
  });

  test('AC-8: the prune pass keeps an archived thread that is still running', async () => {
    const f = await fixture();
    await f.seedRunningThread({ threadId: 't1' });
    await mkdir(join(f.home.dir, 'threads', 't1'), { recursive: true });
    const daemon = await f.daemon();
    try {
      await waitFor(() => f.fleet.syncs.length >= 1);
      f.fleet.archivedThreadIds = ['t1'];
      await waitFor(() => f.fleet.syncs.length >= 2);
      await Bun.sleep(200);   // at least one prune interval with the archived list in hand
      expect(existsSync(join(f.home.dir, 'threads', 't1'))).toBe(true);
    } finally {
      await daemon.stop();
    }
  });

  test('AC-9: the prune pass removes a skill snapshot older than thirty days', async () => {
    const f = await fixture();
    const snapshot = join(f.home.dir, 'skills', 's1', 'a'.repeat(40));
    await mkdir(snapshot, { recursive: true });
    const old = new Date(Date.now() - 31 * 86_400_000);
    await utimes(snapshot, old, old);
    const daemon = await f.daemon();
    try {
      await waitFor(() => !existsSync(snapshot), { timeoutMs: 10_000 });
    } finally {
      await daemon.stop();
    }
  });
});

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssignPayload, FleetCommandOut, SyncRequest } from '@nathapp/fleet-protocol';
import { parseRunnerConfig, resolveHome } from '../../src/config/runner-config';
import { startDaemon } from '../../src/daemon/daemon';
import { Journal } from '../../src/journal/journal';
import type { Git } from '../../src/executor/git';
import { createMemoryLogger } from '../../src/logger';
import { assignFor } from '../helpers/assign';
import { FakeExecutor } from '../helpers/fake-executor';
import { makeTempDirs } from '../helpers/tmp';
import { waitFor } from '../helpers/wait';
import { NaxUnavailableError, type NaxResult } from '../../src/nax/nax-cli';
import { WorkspaceUntrustedError } from '../../src/nax/trust';
import { FakeNaxCli } from '../helpers/fake-nax-cli';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

interface FakeServer {
  url: string;
  syncs: SyncRequest[];
  uploads: Array<{ path: string; epoch: string | null; sha: string | null; bytes: number }>;
  queue: FleetCommandOut[];
  mode: { status: number; capacity: number };
  stop(): void;
}

function fakeServer(): FakeServer {
  const acked = new Map<string, number>();
  const server: FakeServer = { url: '', syncs: [], uploads: [], queue: [], mode: { status: 200, capacity: 2 }, stop: () => undefined };
  const bun = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const envelope = (data: unknown, status = 200) => new Response(JSON.stringify({ ret: 0, data }), { status });
      if (url.pathname === '/api/fleet/runner/me') return envelope({ id: 'r1', name: 'box', labels: [], capacity: server.mode.capacity, enabled: true });
      if (url.pathname.endsWith('/bundle') && req.method === 'PUT') {
        const bytes = (await req.arrayBuffer()).byteLength;
        server.uploads.push({ path: url.pathname, epoch: url.searchParams.get('leaseEpoch'), sha: req.headers.get('x-content-sha256'), bytes });
        return envelope({}, 201);
      }
      if (url.pathname === '/api/fleet/runner/sync') {
        if (server.mode.status !== 200) return new Response(JSON.stringify({ ret: 1, message: 'Unsupported protocol version' }), { status: server.mode.status });
        const body = (await req.json()) as SyncRequest;
        server.syncs.push(body);
        const jobAcks = body.jobs.map((j) => {
          let next = (acked.get(j.jobId) ?? 0) + 1;
          for (const e of [...j.events].sort((a, b) => a.seq - b.seq)) if (e.seq === next) next += 1;
          acked.set(j.jobId, next - 1);
          return { jobId: j.jobId, ackedSeq: next - 1 };
        });
        const commands = server.queue.splice(0);
        if (jobAcks.length === 0 && commands.length === 0) await Bun.sleep(25);
        return envelope({ jobAcks, commands, gitTokens: [], gitTokenErrors: [], unknownJobIds: [] });
      }
      return new Response('nope', { status: 404 });
    },
  });
  server.url = `http://127.0.0.1:${bun.port}`;
  server.stop = () => bun.stop(true);
  return server;
}

async function setup(server: FakeServer) {
  const base = await tmp.make('daemon');
  const home = resolveHome({}, join(base, 'home'));
  const config = parseRunnerConfig({
    serverUrl: server.url, workspaceRoot: join(base, 'ws'), naxHome: join(base, 'naxhome'), jobRetentionDays: 1, socketDir: join(base, 's'),
    capabilities: { nax: { version: '0.83.0', protocols: ['native'] }, sandbox: { available: true }, tools: { git: true, gh: true, glab: false }, executors: ['host'] },
  }, {});
  const identity = { runnerId: 'r1', apiKey: 'kr_test', serverUrl: server.url, name: 'box', enrolledAt: '2026-10-01T00:00:00.000Z' };
  const bundle = join(base, 'bundle.tar.gz');
  await writeFile(bundle, 'bundle-bytes');
  const ex = new FakeExecutor();
  ex.bundle = { path: bundle, size: 12, sha256: 'a'.repeat(64) };
  ex.dieAfterTicks(1);
  return { base, home, config, identity, ex };
}
const tuning = { syncMinGapMs: 5, statusPollMs: 5, syncTimeoutMs: 2_000, ackPollMs: 5 };
const events = (server: FakeServer) => server.syncs.flatMap((s) => s.jobs.flatMap((j) => j.events.map((e) => ({ ...e, jobId: j.jobId }))));

describe('startDaemon', () => {
  test('enrolled runner syncs with capabilities and free slots, takes an ASSIGN, runs it, uploads the bundle and gets every event acked', async () => {
    const server = fakeServer();
    const s = await setup(server);
    const log = createMemoryLogger();
    const daemon = await startDaemon({ home: s.home, config: s.config, identity: s.identity, tuning, log, executorFactory: () => s.ex });
    try {
      await waitFor(() => server.syncs.length >= 1);
      expect(server.syncs[0]).toMatchObject({ protocolVersion: 1, bootId: daemon.bootId, freeSlots: 2, jobs: [] });
      expect(server.syncs[0].capabilities).toMatchObject({ nax: { version: '0.83.0' }, tools: { gh: true }, executors: ['host'] });
      await waitFor(() => server.syncs.length >= 2);
      expect(server.syncs[1].capabilities).toBeUndefined();          // confirmed after the first success
      server.queue.push({ commandId: 'c1', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1, payload: assignFor('RUN') });
      await waitFor(() => events(server).some((e) => e.type === 'state' && (e.payload as { to: string }).to === 'COMPLETED'), { timeoutMs: 8_000 });
      expect(events(server).filter((e) => e.type === 'state').map((e) => (e.payload as { to: string }).to)).toEqual(['RUNNING', 'UPLOADING', 'COMPLETED']);
      expect(server.syncs.some((sync) => sync.commandAcks.some((a) => a.commandId === 'c1' && a.result === 'ok'))).toBe(true);
      expect(server.uploads).toEqual([{ path: '/api/fleet/runner/jobs/j1/bundle', epoch: '1', sha: 'a'.repeat(64), bytes: 12 }]);
      await waitFor(() => daemon.journal.jobsWithPending().length === 0);
      expect(daemon.journal.getJob('j1', 1)?.doneAt).not.toBeNull();
      await waitFor(() => server.syncs.at(-1)?.freeSlots === 2);
      expect(JSON.stringify(log.lines)).not.toContain('kr_test');
    } finally {
      await daemon.stop();
      server.stop();
    }
  });

  test('a job in flight does not count as a free slot', async () => {
    const server = fakeServer();
    const s = await setup(server);
    s.ex.onTick = () => undefined;                                   // never exits on its own
    const daemon = await startDaemon({ home: s.home, config: s.config, identity: s.identity, tuning, executorFactory: () => s.ex });
    try {
      server.queue.push({ commandId: 'c1', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1, payload: assignFor('RUN') });
      await waitFor(() => server.syncs.some((sync) => sync.freeSlots === 1));
    } finally {
      s.ex.alive = false;
      await daemon.stop();
      server.stop();
    }
  });

  test('426 stops the loop and resolves stopped with the protocol reason', async () => {
    const server = fakeServer();
    server.mode.status = 426;
    const s = await setup(server);
    const daemon = await startDaemon({ home: s.home, config: s.config, identity: s.identity, tuning, log: createMemoryLogger(), executorFactory: () => s.ex });
    try {
      expect(await daemon.stopped).toMatchObject({ kind: 'protocol' });
    } finally {
      await daemon.stop();
      server.stop();
    }
  });

  test('an unreachable server at boot leaves capacity unknown: the daemon starts and reports freeSlots 0 until /me answers', async () => {
    const server = fakeServer();
    const s = await setup(server);
    let failMe = true;
    const fetchFn = async (url: string, init?: RequestInit) => {
      if (failMe && url.endsWith('/me')) throw new TypeError('connect ECONNREFUSED');
      return fetch(url, init);
    };
    const daemon = await startDaemon({ home: s.home, config: s.config, identity: s.identity, tuning: { ...tuning, capacityRefreshMs: 30 }, log: createMemoryLogger(), fetchFn, executorFactory: () => s.ex });
    try {
      await waitFor(() => server.syncs.length >= 1);
      expect(server.syncs[0].freeSlots).toBe(0);
      failMe = false;
      await waitFor(() => server.syncs.at(-1)?.freeSlots === 2);
    } finally {
      await daemon.stop();
      server.stop();
    }
  });

  test('startup housekeeping: orphan job profiles are deleted, jobs done more than the retention ago are pruned with their directories, active jobs are kept', async () => {
    const server = fakeServer();
    const s = await setup(server);
    await mkdir(s.home.dir, { recursive: true });
    const old = Journal.open(s.home.journalPath, () => new Date('2026-01-01T00:00:00.000Z'));
    const oldDir = join(s.config.workspaceRoot, '.jobs', 'jold');
    const liveDir = join(s.config.workspaceRoot, '.jobs', 'jlive');
    for (const [id, dir] of [['jold', oldDir], ['jlive', liveDir]] as const) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'marker'), 'x');
      old.insertJob({ assign: assignFor('RUN', { jobId: id }) as AssignPayload, leaseEpoch: 1, repoKey: 'acme/app', jobDir: dir });
    }
    old.markDone('jold', 1);
    old.close();
    await mkdir(join(s.config.naxHome, 'profiles'), { recursive: true });
    for (const name of ['koda-job-jorphan.json', 'koda-job-jlive.json', 'machine.json']) await writeFile(join(s.config.naxHome, 'profiles', name), '{}');
    const daemon = await startDaemon({ home: s.home, config: s.config, identity: s.identity, tuning, executorFactory: () => s.ex });
    try {
      expect(daemon.journal.getJob('jold', 1)).toBeNull();
      expect(daemon.journal.getJob('jlive', 1)).not.toBeNull();
      await expect(stat(oldDir)).rejects.toThrow();
      expect(await readFile(join(liveDir, 'marker'), 'utf8')).toBe('x');
      await expect(stat(join(s.config.naxHome, 'profiles', 'koda-job-jorphan.json'))).rejects.toThrow();
      await stat(join(s.config.naxHome, 'profiles', 'koda-job-jlive.json'));
      await stat(join(s.config.naxHome, 'profiles', 'machine.json'));
      expect(daemon.journal.getMeta('runner_id')).toBe('r1');
      expect(daemon.journal.getMeta('boot_id')).toBe(daemon.bootId);
    } finally {
      await daemon.stop();
      server.stop();
    }
  });

  test('ENH-3: a pruned job whose nax-out still has files is logged before removal, and the dir is still removed', async () => {
    const server = fakeServer();
    const s = await setup(server);
    await mkdir(s.home.dir, { recursive: true });
    const old = Journal.open(s.home.journalPath, () => new Date('2026-01-01T00:00:00.000Z'));
    const oldDir = join(s.config.workspaceRoot, '.jobs', 'jorphan');
    await mkdir(join(oldDir, 'nax-out'), { recursive: true });
    for (const name of ['run-1.log', 'checkpoint.jsonl']) await writeFile(join(oldDir, 'nax-out', name), 'kept');
    old.insertJob({ assign: assignFor('RUN', { jobId: 'jorphan' }) as AssignPayload, leaseEpoch: 1, repoKey: 'acme/app', jobDir: oldDir });
    old.markDone('jorphan', 1);
    old.close();
    const log = createMemoryLogger();
    const daemon = await startDaemon({ home: s.home, config: s.config, identity: s.identity, tuning, log, executorFactory: () => s.ex });
    try {
      expect(daemon.journal.getJob('jorphan', 1)).toBeNull();
      await expect(stat(oldDir)).rejects.toThrow();
      const warn = log.lines.find((l) => l.message.includes('nax-out still has files'));
      expect(warn).toBeDefined();
      expect((warn?.fields as { count?: number }).count).toBe(2);
    } finally {
      await daemon.stop();
      server.stop();
    }
  });

  test('SEC-1: home dir is created 0o700 and the journal 0o600', async () => {
    if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) return;
    const server = fakeServer();
    const s = await setup(server);
    const daemon = await startDaemon({ home: s.home, config: s.config, identity: s.identity, tuning, executorFactory: () => s.ex });
    try {
      expect((await stat(s.home.dir)).mode & 0o777).toBe(0o700);
      expect((await stat(s.home.journalPath)).mode & 0o777).toBe(0o600);
    } finally {
      await daemon.stop();
      server.stop();
    }
  });

  test('stop never kills a running job; a second daemon on the same home has a new boot id and finds the journal', async () => {
    const server = fakeServer();
    const s = await setup(server);
    s.ex.onTick = () => undefined;
    const first = await startDaemon({ home: s.home, config: s.config, identity: s.identity, tuning, executorFactory: () => s.ex });
    server.queue.push({ commandId: 'c1', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1, payload: assignFor('RUN') });
    await waitFor(() => s.ex.ticks >= 1);
    await first.stop();
    await first.stop();                                              // idempotent
    expect(s.ex.killed).toEqual([]);
    const second = await startDaemon({ home: s.home, config: s.config, identity: s.identity, tuning, executorFactory: () => new FakeExecutor() });
    try {
      expect(second.bootId).not.toBe(first.bootId);
      expect(second.journal.getJob('j1', 1)).toMatchObject({ state: 'RUNNING', pid: 4242 });
      await waitFor(() => server.syncs.some((sync) => sync.bootId === second.bootId));
    } finally {
      await second.stop();
      server.stop();
      s.ex.alive = false;
    }
  });

  test('stop waits for a halted run to end before it closes the journal (D67)', async () => {
    const server = fakeServer();
    const s = await setup(server);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let preparing = false;
    s.ex.prepare = async () => { preparing = true; await gate; return { ok: true, branch: 'feat/x' }; };
    const daemon = await startDaemon({ home: s.home, config: s.config, identity: s.identity, tuning, executorFactory: () => s.ex });
    try {
      server.queue.push({ commandId: 'c1', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1, payload: assignFor('RUN') });
      await waitFor(() => preparing);
      let closed = false;
      const close = daemon.journal.close.bind(daemon.journal);
      daemon.journal.close = () => { closed = true; close(); };
      // The halt is set by supervisor.shutdown(); wait for that observable point instead of a fixed
      // number of loop turns — under CI load two settles let the gated run resume and spawn first.
      const halted = new Promise<void>((resolve) => {
        const shutdown = daemon.supervisor.shutdown.bind(daemon.supervisor);
        daemon.supervisor.shutdown = () => { resolve(); shutdown(); };
      });
      const stopping = daemon.stop();
      await halted;
      expect(closed).toBe(false);                                     // the run is still inside prepare
      release();
      await stopping;
      expect(closed).toBe(true);
      expect(s.ex.calls).not.toContain('spawn:j1');                   // halted: it never went on to spawn
    } finally {
      release();
      server.stop();
    }
  });

  test('crash closes the journal at once, drains nothing and touches no child; the next daemon meets the RUNNING row (D40, D67)', async () => {
    const server = fakeServer();
    const s = await setup(server);
    s.ex.onTick = () => undefined;
    const first = await startDaemon({ home: s.home, config: s.config, identity: s.identity, tuning, executorFactory: () => s.ex });
    server.queue.push({ commandId: 'c1', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1, payload: assignFor('RUN') });
    await waitFor(() => s.ex.ticks >= 1);
    first.crash();
    expect(() => first.journal.getJob('j1', 1)).toThrow();            // closed, not drained
    expect(s.ex.killed).toEqual([]);
    await first.stopped;                                              // the aborted loop ends
    await first.stop();                                               // a stop after a crash is a no-op
    const second = await startDaemon({ home: s.home, config: s.config, identity: s.identity, tuning, executorFactory: () => new FakeExecutor() });
    try {
      expect(second.bootId).not.toBe(first.bootId);
      expect(second.journal.getJob('j1', 1)).toMatchObject({ state: 'RUNNING', pid: 4242 });
    } finally {
      await second.stop();
      server.stop();
      s.ex.alive = false;
    }
  });

  test('refuses to start with a git older than 2.30, before it creates anything (D69)', async () => {
    const server = fakeServer();
    const s = await setup(server);
    const oldGit: Git = { run: async () => ({ code: 0, stdout: 'git version 2.29.2\n', stderr: '' }), ok: async () => 'git version 2.29.2\n' };
    await expect(startDaemon({ home: s.home, config: s.config, identity: s.identity, tuning, git: oldGit, executorFactory: () => s.ex })).rejects.toThrow(/git 2\.30 or newer/);
    await expect(stat(s.home.journalPath)).rejects.toThrow();
    await expect(stat(join(s.config.workspaceRoot, '.jobs'))).rejects.toThrow();
    server.stop();
  });
});

describe('startDaemon, capabilities from nax (D95, D97, D102, D103)', () => {
  async function probed(server: FakeServer, nax: FakeNaxCli) {
    const s = await setup(server);
    const config = parseRunnerConfig({
      serverUrl: server.url, workspaceRoot: join(s.base, 'ws'), naxHome: join(s.base, 'naxhome'), jobRetentionDays: 1, socketDir: join(s.base, 's'),
    }, {});
    const start = (over: Partial<Parameters<typeof startDaemon>[0]> = {}) =>
      startDaemon({ home: s.home, config, identity: s.identity, tuning, nax, executorFactory: () => s.ex, ...over });
    return { ...s, config, start };
  }
  const withCapabilities = (server: FakeServer) => server.syncs.filter((sync) => sync.capabilities !== undefined);

  test('without a capabilities block the first sync carries what nax reported; the workspace root was checked for trust', async () => {
    const server = fakeServer();
    const nax = new FakeNaxCli({ version: '0.83.1' });
    const p = await probed(server, nax);
    const log = createMemoryLogger();
    const daemon = await p.start({ log });
    try {
      await waitFor(() => server.syncs.length >= 1);
      expect(server.syncs[0].capabilities).toMatchObject({ nax: { version: '0.83.1' }, profiles: {}, sandbox: { available: true }, executors: ['host'] });
      expect(nax.calls.some((c) => c.args[0] === 'trust' && c.args[c.args.length - 1] === p.config.workspaceRoot)).toBe(true);
      expect(log.lines.some((l) => l.message.includes('nax is not probed'))).toBe(false);
    } finally {
      await daemon.stop();
      server.stop();
    }
  });

  test('D97: nax older than 0.83.1 stops the start with NaxUnavailableError; nothing is sent', async () => {
    const server = fakeServer();
    const p = await probed(server, new FakeNaxCli({ version: '0.83.0' }));
    await expect(p.start()).rejects.toBeInstanceOf(NaxUnavailableError);
    expect(server.syncs).toEqual([]);
    server.stop();
  });

  test('Review focus 4, D103: an untrusted workspace root stops the start and names the nax trust add command', async () => {
    const server = fakeServer();
    const p = await probed(server, new FakeNaxCli({ trusted: false }));
    const failure = p.start();
    await expect(failure).rejects.toBeInstanceOf(WorkspaceUntrustedError);
    await expect(failure).rejects.toThrow(`nax trust add ${p.config.workspaceRoot} --yes`);
    expect(server.syncs).toEqual([]);
    server.stop();
  });

  test('D102: reprobe sends a changed report once; an unchanged one is not resent', async () => {
    const server = fakeServer();
    const nax = new FakeNaxCli({ version: '0.83.1' });
    const p = await probed(server, nax);
    const daemon = await p.start();
    try {
      await waitFor(() => withCapabilities(server).length === 1 && server.syncs.length >= 2);
      await daemon.reprobe();
      await Bun.sleep(50);
      expect(withCapabilities(server)).toHaveLength(1);
      nax.answers = { ...nax.answers, version: '0.84.0' };
      await daemon.reprobe();
      await waitFor(() => withCapabilities(server).length === 2);
      expect(withCapabilities(server)[1].capabilities?.nax.version).toBe('0.84.0');
    } finally {
      await daemon.stop();
      server.stop();
    }
  });

  test('Review focus 3: a probe that fails after start keeps the last report, warns, and the daemon keeps syncing', async () => {
    const server = fakeServer();
    const nax = new FakeNaxCli({ version: '0.83.1' });
    const p = await probed(server, nax);
    const log = createMemoryLogger();
    const daemon = await p.start({ log });
    try {
      await waitFor(() => server.syncs.length >= 2);
      const gone: NaxResult = { code: 127, stdout: '', stderr: 'nax: not found', timedOut: false };
      nax.answers = { ...nax.answers, version: gone };
      await daemon.reprobe();
      expect(log.lines.some((l) => l.level === 'warn' && l.message.includes('capability probe failed'))).toBe(true);
      const before = server.syncs.length;
      await waitFor(() => server.syncs.length > before);
    } finally {
      await daemon.stop();
      server.stop();
    }
  });

  test('D102: the periodic probe runs every capabilityProbeMs', async () => {
    const server = fakeServer();
    const nax = new FakeNaxCli();
    const p = await probed(server, nax);
    const daemon = await p.start({ tuning: { ...tuning, capabilityProbeMs: 30 } });
    try {
      await waitFor(() => nax.calls.filter((c) => c.args[0] === '--version').length >= 3);
    } finally {
      await daemon.stop();
      server.stop();
    }
  });
});

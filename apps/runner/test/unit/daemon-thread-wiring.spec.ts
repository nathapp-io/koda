import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssignPayload, RunnerCapabilities, SyncRequest, SyncResponse, ThreadAssign } from '@nathapp/fleet-protocol';
import { parseRunnerConfig, resolveHome } from '../../src/config/runner-config';
import { startDaemon } from '../../src/daemon/daemon';
import { Journal } from '../../src/journal/journal';
import { createMemoryLogger } from '../../src/logger';
import { ServerClient, type FetchFn } from '../../src/sync/http';
import { SyncLoop, type SyncLoopDeps } from '../../src/sync/sync-loop';
import type { ThreadHostDeps } from '../../src/thread/thread-job-run';
import { FakeExecutor } from '../helpers/fake-executor';
import { FakeNaxCli } from '../helpers/fake-nax-cli';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
afterEach(() => tmp.cleanup());

const threadAssign = (jobId: string): AssignPayload => {
  const thread: ThreadAssign = {
    threadId: `thread-${jobId}`, action: 'SESSION', feature: 'brainstorm-x', resume: false,
    instructions: 'be helpful', backend: { kind: 'native', model: 'minimax/MiniMax-M3' }, skills: [], initialMessage: null,
  };
  return {
    jobId, command: 'THREAD', repo: { provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: 'file:///repo' },
    ref: 'main', feature: `thread-${jobId}`, planFrom: null, profiles: [], maxCostUsd: '5', bashMode: 'raw',
    approvalTimeoutSec: 600, gitIdentity: { name: 'bot', email: 'bot@example.test' }, thread,
  };
};

const response: SyncResponse = { jobAcks: [], commands: [], gitTokens: [], gitTokenErrors: [], unknownJobIds: [] };

describe('US-007 daemon thread wiring', () => {
  test('US-007 AC-5: activeCountExcluding omits active THREAD jobs and counts active RUN jobs', () => {
    const journal = Journal.open(':memory:');
    try {
      const run: AssignPayload = {
        jobId: 'run-1', command: 'RUN', repo: { provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: 'file:///repo' },
        ref: 'main', feature: 'run', planFrom: null, profiles: [], maxCostUsd: '5', bashMode: 'raw', approvalTimeoutSec: 600,
        gitIdentity: { name: 'bot', email: 'bot@example.test' },
      };
      journal.insertJob({ assign: run, leaseEpoch: 1, repoKey: 'acme/app', jobDir: '/work/run' });
      journal.insertJob({ assign: threadAssign('thread-1'), leaseEpoch: 1, repoKey: 'acme/app', jobDir: '/work/thread' });
      const countExcluding = Reflect.get(journal, 'activeCountExcluding');
      expect(typeof countExcluding).toBe('function');
      if (typeof countExcluding === 'function') expect(Reflect.apply(countExcluding, journal, ['THREAD'])).toBe(1);
    } finally {
      journal.close();
    }
  });

  test('US-007 AC-6: SyncLoop forwards archived thread IDs received from the server', async () => {
    const journal = Journal.open(':memory:');
    const archived: string[][] = [];
    const emptyCaps = null;
    const deps: SyncLoopDeps = {
      client: { sync: async (_request: SyncRequest) => ({ ...response, archivedThreadIds: ['t1'] }) },
      journal, bootId: 'boot', daemonVersion: 'test', freeSlots: () => 2,
      capabilityReport: () => emptyCaps, onCapabilitiesSent: () => undefined,
      handleCommands: async () => [], abandonUnknown: async () => undefined,
      tokenRequests: () => [], onTokens: () => undefined, onStop: () => undefined,
      log: createMemoryLogger(), sleep: async () => undefined, random: () => 0.5, nowMs: () => 0, minGapMs: 0,
      ...({ onArchivedThreads: (ids: readonly string[]) => archived.push([...ids]) }),
    };
    const loop = new SyncLoop(deps);
    try {
      await loop.syncOnce();
      expect(archived).toEqual([['t1']]);
    } finally {
      loop.stop();
      journal.close();
    }
  });

  test('US-007 AC-10: native model reporting filters configured tiers by latest available credentials', async () => {
    const base = await tmp.make('native-models');
    await writeFile(join(base, 'config.json'), JSON.stringify({ models: { native: { fast: 'minimax/MiniMax-M2.7', balanced: 'zai/glm-5' } } }));
    const caps = {
      credentials: [
        { providerId: 'minimax', available: true },
        { providerId: 'zai', available: false },
      ],
    } as RunnerCapabilities;
    const loaded = await import('../../src/thread/native-models');
    const modulePath = '../../src/thread/thread-host';
    const hostModule = await import(modulePath).catch(() => ({}));
    const makeNativeModels = Reflect.get(hostModule, 'threadNativeModels');
    expect(typeof makeNativeModels).toBe('function');
    if (typeof makeNativeModels === 'function') {
      const nativeModels = Reflect.apply(makeNativeModels, undefined, [base, () => caps]);
      expect(typeof nativeModels).toBe('function');
      if (typeof nativeModels === 'function') {
        const models: unknown = await Reflect.apply(nativeModels, undefined, []);
        expect(typeof models).toBe('object');
        if (typeof models === 'object' && models !== null) expect(Reflect.get(models, 'models')).toEqual(['minimax/MiniMax-M2.7']);
      }
    }
    expect(loaded.readNativeModels).toBeDefined();
  });

  test('US-007 AC-11: native model reporting with no capability report has no models or default', async () => {
    const base = await tmp.make('empty-native-models');
    await mkdir(base, { recursive: true });
    const modulePath = '../../src/thread/thread-host';
    const loaded = await import(modulePath).catch(() => ({}));
    const makeNativeModels = Reflect.get(loaded, 'threadNativeModels');
    expect(typeof makeNativeModels).toBe('function');
    if (typeof makeNativeModels === 'function') {
      const nativeModels = Reflect.apply(makeNativeModels, undefined, [base, () => null]);
      expect(typeof nativeModels).toBe('function');
      if (typeof nativeModels === 'function') {
        const models: unknown = await Reflect.apply(nativeModels, undefined, []);
        expect(models).toEqual({ models: [], defaultModel: null });
      }
    }
  });
});

describe('US-006 daemon koda tools wiring', () => {
  const emptyEnvelope = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify({ ret: 0, data }), { status, headers: { 'content-type': 'application/json' } });

  /** The daemon's own fetch seam: /me and /sync answer, so the start needs no listening server. */
  const daemonFetch = (): FetchFn => async (url) => {
    if (url.endsWith('/me')) return emptyEnvelope({ id: 'r1', name: 'box', labels: [], capacity: 2, enabled: true });
    if (url.endsWith('/sync')) return emptyEnvelope({ jobAcks: [], commands: [], gitTokens: [], gitTokenErrors: [], unknownJobIds: [] });
    return emptyEnvelope({ content: 'unexpected', isError: true });
  };

  test('US-006 kodaTools AC-13: the thread host caller reaches ServerClient.callKodaTool with the same arguments', async () => {
    const base = await tmp.make('koda-tool-wiring');
    const home = resolveHome({}, join(base, 'home'));
    // A unix socket path is capped at 100 bytes, and a child of this run's scratch root would be over the cap
    // (TMPDIR is deep under the nax sandbox), so the daemon gets the shortest temp directory that still fits.
    const socketDir = join(tmpdir(), 'kw');
    // No capabilities block: the runner asks nax, which is what gives it a thread host at all.
    const config = parseRunnerConfig({
      serverUrl: 'http://127.0.0.1:9', workspaceRoot: join(base, 'ws'), naxHome: join(base, 'naxhome'),
      jobRetentionDays: 1, socketDir,
    }, {});
    const identity = { runnerId: 'r1', apiKey: 'kr_test', serverUrl: config.serverUrl, name: 'box', enrolledAt: '2026-10-01T00:00:00.000Z' };
    const seen: Array<{ jobId: string; leaseEpoch: number; name: string; toolCallId: string; input: unknown; signal?: AbortSignal }> = [];
    const original = ServerClient.prototype.callKodaTool;
    ServerClient.prototype.callKodaTool = async function (args) {
      seen.push(args);
      return { content: 'ticket WEB-1', isError: false };
    };
    const daemon = await startDaemon({
      home, config, identity, log: createMemoryLogger(), fetchFn: daemonFetch(), nax: new FakeNaxCli({ version: '0.83.1' }),
      tuning: { syncMinGapMs: 5, statusPollMs: 5, syncTimeoutMs: 2_000, ackPollMs: 5 }, executorFactory: () => new FakeExecutor(),
    });
    try {
      const deps = Reflect.get(daemon.supervisor, 'deps') as { threads?: { host: ThreadHostDeps } };
      const caller = deps.threads?.host.kodaTools;
      expect(typeof caller?.call).toBe('function');
      if (caller === undefined) return;
      const args = { jobId: 'j1', leaseEpoch: 3, name: 'koda_get_ticket', toolCallId: 'c1', input: { ref: 'WEB-1' }, signal: new AbortController().signal };
      const answer = await caller.call(args);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ jobId: 'j1', leaseEpoch: 3, name: 'koda_get_ticket', toolCallId: 'c1', input: { ref: 'WEB-1' } });
      expect(seen[0]?.signal).toBe(args.signal);
      expect(answer).toEqual({ content: 'ticket WEB-1', isError: false });
    } finally {
      ServerClient.prototype.callKodaTool = original;
      await daemon.stop();
      await rm(socketDir, { recursive: true, force: true });
    }
  });
});

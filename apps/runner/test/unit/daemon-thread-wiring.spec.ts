import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssignPayload, RunnerCapabilities, SyncRequest, SyncResponse, ThreadAssign } from '@nathapp/fleet-protocol';
import { Journal } from '../../src/journal/journal';
import { createMemoryLogger } from '../../src/logger';
import { SyncLoop, type SyncLoopDeps } from '../../src/sync/sync-loop';
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

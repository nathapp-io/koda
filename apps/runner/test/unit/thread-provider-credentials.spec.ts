import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderKeyGrant, RunnerCapabilities, ThreadAssign } from '@nathapp/fleet-protocol';
import {
  createFileTranscriptStore,
  nativeBackend,
  type AgentSession,
  type CreateAgentSessionOptions,
  type NativeBackendOptions,
} from '@nathapp/nax-agent';
import type { AcpBackendOptions } from '@nathapp/nax-agent-acp/client';
import type { CredentialProvider } from '../../src/credentials/broker';
import { CredentialBroker } from '../../src/credentials/broker';
import { requestProviderKey } from '../../src/credentials/provider-cred';
import { ProviderKeyCache } from '../../src/credentials/provider-key-cache';
import { TokenCache } from '../../src/credentials/token-cache';
import type { Git } from '../../src/executor/git';
import { Journal } from '../../src/journal/journal';
import type { JobRow } from '../../src/journal/types';
import { createMemoryLogger } from '../../src/logger';
import type { NativeModelSet } from '../../src/thread/native-models';
import { ThreadSessionFactory, type ThreadProviderKeys } from '../../src/thread/session-factory';
import { threadNativeModels } from '../../src/thread/thread-host';
import { ThreadJobRun } from '../../src/thread/thread-job-run';
import { assignFor } from '../helpers/assign';
import { isNaxSandboxed } from '../helpers/test-environment';
import { waitFor } from '../helpers/wait';

// US-011: the runner's own argv, as every credential-carrying seam spells it.
const SELF = ['/k/koda-runner'];
const SOCKET = '/run/provider-keys.sock';

const session: AgentSession = {
  id: 'thread-1', backend: { kind: 'native', capabilities: {} }, lastTurn: undefined,
  async *send() {},
  answer: () => 'unknown', cancel: () => undefined, close: async () => undefined,
};

const turnSession: AgentSession = {
  ...session,
  async *send() { yield { type: 'turn_end', sessionId: 'thread-1', turnId: 'turn-1', at: new Date(0).toISOString(), status: 'completed' } as never; },
};

function thread(overrides: Partial<ThreadAssign> = {}): ThreadAssign {
  return {
    threadId: 'thread-1', action: 'SESSION', feature: 'feature', resume: false,
    instructions: 'instructions', backend: { kind: 'native', model: 'openrouter/qwen3' }, skills: [], initialMessage: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// ThreadSessionFactory: the provider lookup and the per-session exec credential source.
// ---------------------------------------------------------------------------------------------------------------

/** What `open` was given for `providerKeys`: omitted (`none`), denied, granted, or a lookup that throws. */
type ProviderKeysMode = 'none' | 'denied' | 'granted' | 'throwing';

function factorySetup(overrides: {
  models?: string[];
  defaultModel?: string | null;
  providerKeys?: ProviderKeysMode;
  /** `'default'` builds the factory without one, so it resolves this runner's own argv. */
  selfCommand?: readonly string[] | 'default';
  /** F2: the production selector, instead of a literal model list. */
  nativeModels?: () => Promise<NativeModelSet>;
} = {}) {
  const selfCommand = overrides.selfCommand ?? SELF;
  const calls = {
    granted: [] as string[],
    native: [] as NativeBackendOptions[],
    acp: [] as AcpBackendOptions[],
    create: [] as CreateAgentSessionOptions[],
  };
  const acpSentinel = { kind: 'acp:codex', open: async () => { throw new Error('this spec never opens an ACP backend'); } };
  const factory = new ThreadSessionFactory({
    homeDir: '/runner-home',
    naxHome: '/nax-home',
    ...(selfCommand === 'default' ? {} : { selfCommand }),
    nativeModels: overrides.nativeModels ?? (async () => ({
      models: overrides.models ?? ['openrouter/qwen3', 'openrouter/default', 'qwen3'],
      defaultModel: overrides.defaultModel === undefined ? 'openrouter/qwen3' : overrides.defaultModel,
    })),
    agent: {
      createAgentSession: async (options: CreateAgentSessionOptions) => { calls.create.push(options); return session; },
      resumeAgentSession: async () => session,
      nativeBackend: (options: NativeBackendOptions) => { calls.native.push(options); return nativeBackend(options); },
      acpBackend: (options: AcpBackendOptions) => { calls.acp.push(options); return acpSentinel; },
      createFileTranscriptStore: (directory: string) => createFileTranscriptStore(directory),
    },
  });
  const mode = overrides.providerKeys ?? 'none';
  const providerKeys: ThreadProviderKeys | undefined = mode === 'none' ? undefined : {
    socket: SOCKET,
    granted: async (providerId: string) => {
      calls.granted.push(providerId);
      if (mode === 'throwing') throw new Error('the vault is unreachable');
      return mode === 'granted';
    },
  };
  const open = (threadOver: Partial<ThreadAssign> = {}) => factory.open({
    jobId: 'job-1', thread: thread(threadOver), worktree: '/work/tree', tools: [], approvalTimeoutSec: 60,
    ...(providerKeys === undefined ? {} : { providerKeys }),
  });
  return { calls, open };
}

describe('ThreadSessionFactory provider credentials (US-011)', () => {
  test('AC-1: a native open on openrouter/qwen3 asks the provider-key source for openrouter', async () => {
    const h = factorySetup({ providerKeys: 'denied' });
    const result = await h.open();
    expect(result.ok).toBe(true);
    expect(h.calls.granted).toEqual(['openrouter']);
  });

  test('AC-2: a grant opens the native session with the per-session exec credential source', async () => {
    const h = factorySetup({ providerKeys: 'granted' });
    const result = await h.open();
    expect(result.ok).toBe(true);
    expect(h.calls.native[0]?.credentials).toEqual({
      kind: 'exec',
      command: [...SELF, 'provider-cred', '--socket', SOCKET],
      timeoutMs: 60_000,
    });
  });

  test('AC-3: a denial opens the native session without credentials', async () => {
    const h = factorySetup({ providerKeys: 'denied' });
    const result = await h.open();
    expect(result.ok).toBe(true);
    expect(h.calls.native[0]).not.toHaveProperty('credentials');
  });

  test('AC-4: a thread that pins no model asks for the default model\'s provider', async () => {
    const h = factorySetup({ providerKeys: 'denied', defaultModel: 'openrouter/default' });
    const result = await h.open({ backend: { kind: 'native' } });
    expect(result.ok).toBe(true);
    expect(h.calls.granted).toEqual(['openrouter']);
  });

  test('AC-5: an ACP open never asks for a provider key', async () => {
    const h = factorySetup({ providerKeys: 'granted' });
    const result = await h.open({ backend: { kind: 'acp', agent: 'codex', model: 'openrouter/qwen3' } });
    expect(result.ok).toBe(true);
    expect(h.calls.acp).toHaveLength(1);
    expect(h.calls.granted).toEqual([]);
  });

  test('AC-6: an open with no providerKeys carries no credentials', async () => {
    const h = factorySetup({ providerKeys: 'none' });
    const result = await h.open();
    expect(result.ok).toBe(true);
    expect(h.calls.native[0]).not.toHaveProperty('credentials');
  });

  test('AC-7: a model id with no provider prefix asks nothing and carries no credentials', async () => {
    const h = factorySetup({ providerKeys: 'granted' });
    // nax's own options validator refuses a model id with no provider prefix, so only the options this factory
    // built are asserted here: no credentials, and no provider lookup for a provider the id does not name.
    await h.open({ backend: { kind: 'native', model: 'qwen3' } });
    expect(h.calls.granted).toEqual([]);
    expect(h.calls.native).toHaveLength(1);
    expect(h.calls.native[0]).not.toHaveProperty('credentials');
  });

  test('AC-12: an unadvertised model still fails model_unknown and asks nothing', async () => {
    const h = factorySetup({ providerKeys: 'granted', models: ['openrouter/qwen3'] });
    const result = await h.open({ backend: { kind: 'native', model: 'openrouter/missing' } });
    expect(result).toEqual({ ok: false, reason: 'model_unknown' });
    expect(h.calls.granted).toEqual([]);
    expect(h.calls.create).toHaveLength(0);
  });

  test('a lookup that throws opens without credentials, so the machine\'s own store still serves the session', async () => {
    const h = factorySetup({ providerKeys: 'throwing' });
    const result = await h.open();
    expect(result.ok).toBe(true);
    expect(h.calls.native[0]).not.toHaveProperty('credentials');
  });

  test('the exec command names the runner\'s own argv when the factory was built without one', async () => {
    const h = factorySetup({ providerKeys: 'granted', selfCommand: 'default' });
    await h.open();
    const credentials = h.calls.native[0]?.credentials;
    if (credentials?.kind !== 'exec') throw new Error(`expected an exec credential source, got ${JSON.stringify(credentials)}`);
    expect(credentials.command.slice(-3)).toEqual(['provider-cred', '--socket', SOCKET]);
    // The argv before the flag is this runner's own (the compiled binary's entry is dropped under /$bunfs).
    expect(credentials.command.length).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// ThreadJobRun: serving the socket before the open, and releasing it on every exit.
// ---------------------------------------------------------------------------------------------------------------

const root = join(import.meta.dir, `.thread-provider-credentials-${crypto.randomUUID()}`);
const homeDir = join(root, 'runner-home');
const workspaceRoot = join(root, 'workspace');
const jobId = 'thread-job-k1';
const leaseEpoch = 1;
const tuning = {
  threadIdleMs: 60_000, threadHeartbeatMs: 30_000, threadWakeGapMs: 0,
  threadSearchTimeoutMs: 1_000, threadSkillFetchTimeoutMs: 1_000,
  logDrainTimeoutMs: 1_000, threadCloseTimeoutMs: 2_000, threadRunningAckPollMs: 250, threadRunningAckWaitMs: 0,
};

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The credentials seam: `vault` serves provider keys, `acquire-release-only` is a pre-vault fake or runner. */
type CredentialsMode = 'vault' | 'acquire-release-only' | 'serve-fails';

function runSetup(overrides: { kind?: 'PROJECT' | 'REPO'; credentials?: CredentialsMode } = {}) {
  const assigned = thread({
    feature: 'thread-k1', skills: [], initialMessage: { messageId: 'm1', text: 'hi' },
    ...(overrides.kind === undefined ? {} : { kind: overrides.kind }),
  });
  const journal = Journal.open(':memory:');
  journal.insertJob({ assign: assignFor('THREAD', { jobId, thread: assigned }), leaseEpoch, repoKey: 'acme/app', jobDir: join(workspaceRoot, '.jobs', jobId) });
  const calls: string[] = [];
  const state: { open?: Record<string, unknown> } = {};
  const mode = overrides.credentials ?? 'vault';
  const credentials: CredentialProvider = {
    async acquire() { calls.push('credentials.acquire'); return { ok: true, credentials: { helper: '/job/git-cred', binDir: null } }; },
    async release() { calls.push('credentials.release'); },
    ...(mode === 'acquire-release-only' ? {} : {
      async serveProviderKeys() {
        calls.push('providerKeys.serve');
        if (mode === 'serve-fails') throw new Error('socket dir unsafe');
        return SOCKET;
      },
      async providerKeyGranted() { calls.push('providerKeys.granted'); return true; },
      async releaseProviderKeys() { calls.push('providerKeys.release'); },
    }),
  };
  const host = {
    sessions: {
      async open(input: Record<string, unknown>) {
        calls.push('sessions.open');
        state.open = input;
        return { ok: true as const, session: turnSession, resumed: false };
      },
    },
    credentials,
    git: { async run() { return { code: 0, stdout: '', stderr: '' }; }, async ok() { return ''; } } as Git,
    homeDir, workspaceRoot,
    async prepareWorktree() { calls.push('prepareWorktree'); return { ok: true as const, worktree: join(root, 'wt'), tipSha: 'b'.repeat(40) }; },
    async ensureSkills() { calls.push('ensureSkills'); return { ok: true as const }; },
  };
  const logs = { register() {}, wake() {}, async drain() { return 'drained' as const; }, stopJob() {} };
  const deps = {
    journal, log: createMemoryLogger(), now: () => new Date('2026-01-01T00:00:00.000Z'),
    sleep: async () => undefined, mutex: { acquire: async () => () => undefined }, logs, host, tuning,
  };
  return { journal, calls, state, run: new ThreadJobRun(deps, jobId, leaseEpoch) };
}

/** A run that reached RUNNING with its stream registered, and the pending `start` promise. */
async function running(overrides: { kind?: 'PROJECT' | 'REPO'; credentials?: CredentialsMode } = {}) {
  const context = runSetup(overrides);
  await mkdir(join(workspaceRoot, '.jobs', jobId), { recursive: true });
  const starting = context.run.start('prepare');
  await waitFor(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'RUNNING');
  return { ...context, finish: async () => { context.run.halt(); await starting; context.journal.close(); } };
}

describe('ThreadJobRun provider keys (US-011)', () => {
  test('AC-8: a PROJECT thread serves the provider-key socket before it opens the session', async () => {
    const ctx = await running({ kind: 'PROJECT' });
    const served = ctx.calls.indexOf('providerKeys.serve');
    const opened = ctx.calls.indexOf('sessions.open');
    expect(served, `calls: ${ctx.calls.join(', ')}`).toBeGreaterThanOrEqual(0);
    expect(opened, `calls: ${ctx.calls.join(', ')}`).toBeGreaterThan(served);
    await ctx.finish();
  });

  test('AC-8: a REPO thread serves the provider-key socket before it opens the session', async () => {
    const ctx = await running({ kind: 'REPO' });
    const served = ctx.calls.indexOf('providerKeys.serve');
    const opened = ctx.calls.indexOf('sessions.open');
    expect(served, `calls: ${ctx.calls.join(', ')}`).toBeGreaterThanOrEqual(0);
    expect(opened, `calls: ${ctx.calls.join(', ')}`).toBeGreaterThan(served);
    await ctx.finish();
  });

  test('AC-9: start() releases the job\'s provider keys before it returns', async () => {
    const ctx = await running({ kind: 'PROJECT' });
    expect(ctx.calls).not.toContain('providerKeys.release');   // still running
    await ctx.finish();
    expect(ctx.calls, `calls: ${ctx.calls.join(', ')}`).toContain('providerKeys.release');
    expect(ctx.calls.lastIndexOf('providerKeys.release')).toBeGreaterThan(ctx.calls.indexOf('sessions.open'));
  });

  test('AC-10: abandon() releases the job\'s provider keys', async () => {
    const context = runSetup({ kind: 'PROJECT' });
    await mkdir(join(workspaceRoot, '.jobs', jobId), { recursive: true });
    const starting = context.run.start('prepare');
    await waitFor(() => context.journal.getJob(jobId, leaseEpoch)?.state === 'RUNNING');
    await context.run.abandon();
    expect(context.calls, `calls: ${context.calls.join(', ')}`).toContain('providerKeys.release');
    await starting;
    context.journal.close();
  });

  test('F1: an abandon while the session open is pending leaves no provider lookup behind', async () => {
    // The factory is real and stuck before its provider lookup, which is the window an abandon can land in: the row
    // is deleted and the socket released, and then the open resumes.
    let unblock: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const seen: string[] = [];
    const credentials: CredentialProvider = {
      async acquire() { seen.push('acquire'); return { ok: true, credentials: { helper: null, binDir: null } }; },
      async release() { seen.push('release'); },
      async serveProviderKeys() { seen.push('serve'); return SOCKET; },
      async providerKeyGranted() { seen.push('granted'); return true; },
      async releaseProviderKeys() { seen.push('releaseProviderKeys'); },
    };
    const journal = Journal.open(':memory:');
    const assigned = thread({
      threadId: 'thread-f1', feature: 'thread-f1', skills: [], initialMessage: null,
      kind: 'PROJECT', backend: { kind: 'native', model: 'openrouter/qwen3' },
    });
    journal.insertJob({ assign: assignFor('THREAD', { jobId, thread: assigned }), leaseEpoch, repoKey: 'acme/app', jobDir: join(root, 'f1', jobId) });
    const host = {
      sessions: new ThreadSessionFactory({
        homeDir, naxHome: join(root, 'nax-home'), selfCommand: SELF,
        nativeModels: async () => { seen.push('nativeModels'); await blocked; return { models: ['openrouter/qwen3'], defaultModel: 'openrouter/qwen3' }; },
        agent: {
          createAgentSession: async () => turnSession,
          resumeAgentSession: async () => turnSession,
          nativeBackend: (options: NativeBackendOptions) => { seen.push('nativeBackend'); return nativeBackend(options); },
          createFileTranscriptStore: (directory: string) => createFileTranscriptStore(directory),
        },
      }),
      credentials,
      git: { async run() { return { code: 0, stdout: '', stderr: '' }; }, async ok() { return ''; } } as Git,
      homeDir, workspaceRoot,
      async prepareWorktree() { return { ok: true as const, worktree: join(root, 'f1-wt'), tipSha: 'b'.repeat(40) }; },
      async ensureSkills() { return { ok: true as const }; },
    };
    const logs = { register() {}, wake() {}, async drain() { return 'drained' as const; }, stopJob() {} };
    const deps = {
      journal, log: createMemoryLogger(), now: () => new Date('2026-01-01T00:00:00.000Z'),
      sleep: async () => undefined, mutex: { acquire: async () => () => undefined }, logs, host, tuning,
    };
    const run = new ThreadJobRun(deps, jobId, leaseEpoch);
    const starting = run.start('prepare');
    try {
      await waitFor(() => seen.includes('nativeModels'));
      await run.abandon();
      const abandonedAt = seen.lastIndexOf('releaseProviderKeys');
      expect(abandonedAt, `abandon released at: ${seen.join(', ')}`).toBeGreaterThanOrEqual(0);
      unblock();
      await starting;
      const afterAbandon = seen.slice(abandonedAt + 1);
      expect(afterAbandon, `calls after the abandonment release: ${seen.join(', ')}`).not.toContain('granted');
      // The run's own final cleanup still happens after the open resolved: the row it releases is the one it retained,
      // because abandon deleted the journal row before the run ended.
      expect(seen.at(-1), `calls: ${seen.join(', ')}`).toBe('releaseProviderKeys');
    } finally {
      journal.close();
    }
  });

  test('AC-13: a provider with only acquire/release opens the session without providerKeys', async () => {
    const ctx = await running({ kind: 'PROJECT', credentials: 'acquire-release-only' });
    expect(ctx.calls, `calls: ${ctx.calls.join(', ')}`).toContain('sessions.open');
    expect(ctx.calls).not.toContain('providerKeys.serve');
    expect(ctx.state.open).not.toHaveProperty('providerKeys');
    await ctx.finish();
  });

  test('a run with a provider-key socket passes the served socket and the broker\'s own lookup into open', async () => {
    const ctx = await running({ kind: 'PROJECT' });
    const providerKeys = ctx.state.open?.['providerKeys'] as ThreadProviderKeys | undefined;
    expect(providerKeys?.socket).toBe(SOCKET);
    expect(typeof providerKeys?.granted).toBe('function');
    expect(await providerKeys?.granted('openrouter')).toBe(true);
    // The lookup is the credential provider's, not a resolution of the run's own.
    expect(ctx.calls).toContain('providerKeys.granted');
    await ctx.finish();
  });

  test('a socket that cannot be served is a warning, and the session opens without providerKeys', async () => {
    const ctx = await running({ kind: 'PROJECT', credentials: 'serve-fails' });
    expect(ctx.calls, `calls: ${ctx.calls.join(', ')}`).toContain('providerKeys.serve');
    expect(ctx.calls, `calls: ${ctx.calls.join(', ')}`).toContain('sessions.open');
    expect(ctx.state.open).not.toHaveProperty('providerKeys');
    await ctx.finish();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// F2: the production model selector must not require a machine-local credential when koda serves the key.
// ---------------------------------------------------------------------------------------------------------------

const seamDirs: string[] = [];
afterAll(async () => {
  await Promise.all(seamDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A nax home whose configured tiers name two models; this machine holds a credential for neither provider. */
async function tierHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'naxsel-'));
  seamDirs.push(home);
  await writeFile(join(home, 'config.json'), JSON.stringify({
    models: { native: { balanced: 'openrouter/qwen3', fast: 'zai/glm-5' } },
  }));
  return home;
}

/** The report a vault-enabled machine probes with no local openrouter login: nax knows the provider, cannot use it. */
function localReport(vault: boolean): RunnerCapabilities {
  return {
    nax: { version: '0.91.7', protocols: ['native'] },
    sandbox: { available: true, probedAt: '2026-10-01T00:00:00.000Z' },
    profiles: {},
    credentials: [{ providerId: 'openrouter', available: false, stored: null, ambient: false }],
    tools: { git: true, gh: false, glab: false },
    executors: ['host'],
    ...(vault ? { providerVault: true as const } : {}),
  };
}

describe('thread model eligibility with the provider vault (F2)', () => {
  test('F2: a vault-enabled runner offers a configured model whose provider only koda can serve', async () => {
    const home = await tierHome();
    const models = await threadNativeModels(home, () => localReport(true))();
    expect(models.models, `offered: ${models.models.join(', ')}`).toEqual(['openrouter/qwen3', 'zai/glm-5']);
    expect(models.defaultModel).toBe('openrouter/qwen3');
  });

  test('F2: without the vault the selector keeps today\'s rule and offers nothing for an unusable provider', async () => {
    const home = await tierHome();
    const models = await threadNativeModels(home, () => localReport(false))();
    expect(models.models).toEqual([]);
    expect(models.defaultModel).toBeNull();
  });

  test('F2: the vault never offers a model no configured tier names', async () => {
    const home = await tierHome();
    const models = await threadNativeModels(home, () => localReport(true))();
    expect(models.models).not.toContain('openrouter/unknown-model');
    expect(models.models).toHaveLength(2);
  });

  test('F2: open with the production selector asks the broker for the model\'s provider when the machine has no key', async () => {
    const home = await tierHome();
    const h = factorySetup({ providerKeys: 'granted', nativeModels: threadNativeModels(home, () => localReport(true)) });
    const result = await h.open({ backend: { kind: 'native', model: 'openrouter/qwen3' } });
    expect(result.ok).toBe(true);
    expect(h.calls.granted).toEqual(['openrouter']);
    expect(h.calls.native[0]?.credentials).toEqual({
      kind: 'exec', command: [...SELF, 'provider-cred', '--socket', SOCKET], timeoutMs: 60_000,
    });
  });
});

/**
 * A real CredentialBroker over a real ProviderKeyCache, a real ThreadSessionFactory and one REPO thread run. The
 * thread's clone URL is an ssh origin, which the broker serves no git token for (D83), so only the provider-key
 * socket is involved here. `serveProviderKeys` replaces the broker's socket listen with a path it would serve from:
 * the nax sandbox refuses a Unix socket bind, so the criterion's own test binds one and the sandbox-runnable tests
 * prove the seam around it. `nativeModels` replaces the factory's model set, which lets a test hold the open at the
 * exact point an abandon can land in.
 */
async function seam(overrides: {
  serveProviderKeys?: (job: JobRow) => Promise<string>;
  nativeModels?: () => Promise<NativeModelSet>;
} = {}) {
  const { serveProviderKeys } = overrides;
  const cache = new ProviderKeyCache({ refreshMarginMs: 60_000 });
  const socketDir = await mkdtemp(join(tmpdir(), 'pkt-'));
  seamDirs.push(socketDir);
  const broker = new CredentialBroker({
    tokens: new TokenCache({ refreshMarginMs: 240_000, cooldownMs: 30_000 }),
    providerKeys: cache, socketDir, runnerId: 'r1', selfCommand: SELF,
    nowMs: () => Date.now(), sleep: (ms: number) => Bun.sleep(ms),
    timing: { waitMs: 2_000, serveWaitMs: 2_000, pollMs: 100, providerKeyWaitMs: 20_000 },
  });
  const credentials: CredentialProvider = serveProviderKeys === undefined ? broker : {
    acquire: (job, options) => broker.acquire(job, options),
    release: (job) => broker.release(job),
    serveProviderKeys,
    providerKeyGranted: (job, providerId) => broker.providerKeyGranted(job, providerId),
    releaseProviderKeys: (job) => broker.releaseProviderKeys(job),
  };
  const native: NativeBackendOptions[] = [];
  const journal = Journal.open(':memory:');
  const assigned = thread({
    threadId: 'thread-seam', feature: 'thread-seam', skills: [], initialMessage: { messageId: 'm1', text: 'hi' },
    kind: 'REPO', backend: { kind: 'native', model: 'openrouter/qwen3' },
  });
  journal.insertJob({
    assign: assignFor('THREAD', { jobId, thread: assigned, repo: { provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: 'ssh://git@github.com/o/n.git' } }),
    leaseEpoch, repoKey: 'acme/app', jobDir: join(root, 'seam-jobs', jobId),
  });
  const host = {
    sessions: new ThreadSessionFactory({
      homeDir, naxHome: join(root, 'nax-home'), selfCommand: SELF,
      nativeModels: overrides.nativeModels ?? (async () => ({ models: ['openrouter/qwen3'], defaultModel: 'openrouter/qwen3' })),
      agent: {
        createAgentSession: async () => turnSession,
        resumeAgentSession: async () => turnSession,
        nativeBackend: (options: NativeBackendOptions) => { native.push(options); return nativeBackend(options); },
        createFileTranscriptStore: (directory: string) => createFileTranscriptStore(directory),
      },
    }),
    credentials,
    repoCredentials: broker,
    git: { async run() { return { code: 0, stdout: '', stderr: '' }; }, async ok() { return ''; } } as Git,
    homeDir, workspaceRoot,
    async prepareWorktree() { return { ok: true as const, worktree: join(root, 'seam-wt'), tipSha: 'b'.repeat(40) }; },
    async ensureSkills() { return { ok: true as const }; },
  };
  const logs = { register() {}, wake() {}, async drain() { return 'drained' as const; }, stopJob() {} };
  const deps = {
    journal, log: createMemoryLogger(), now: () => new Date('2026-01-01T00:00:00.000Z'),
    sleep: async () => undefined, mutex: { acquire: async () => () => undefined }, logs, host, tuning,
  };
  const run = new ThreadJobRun(deps, jobId, leaseEpoch);
  const grant: ProviderKeyGrant = {
    jobId, providerId: 'openrouter', key: 'sk-or-1', account: 'koda:global:fleet', fingerprint: '0123456789ab',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
  /** Answers the opened session's provider request the way the sync loop does, as soon as it is queued. */
  const answerGrant = async (): Promise<void> => {
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      const requests = cache.requests();
      if (requests.length > 0) {
        cache.apply(requests, [grant], []);
        return;
      }
      await Bun.sleep(10);
    }
    throw new Error('the session never asked for a provider key');
  };
  const stop = async (): Promise<void> => {
    run.halt();
    await starting;
    journal.close();
    await broker.closeAll();
  };
  const starting = run.start('prepare');
  return { broker, cache, native, journal, run, starting, answerGrant, stop, grant };
}

// The nax sandbox withholds real Unix socket binding (and its $TMPDIR would push the socket path over the 100-byte
// cap), so this criterion's live socket runs on a host.
describe.skipIf(isNaxSandboxed())('ThreadJobRun with a real provider-key broker (US-011)', () => {
  test('AC-11: a REPO thread turn opens the native session with exec credentials whose socket answers the grant', async () => {
    const w = await seam();
    try {
      await w.answerGrant();
      await waitFor(() => w.journal.getJob(jobId, leaseEpoch)?.state === 'RUNNING');
      const credentials = w.native[0]?.credentials;
      if (credentials?.kind !== 'exec') throw new Error(`expected an exec credential source, got ${JSON.stringify(credentials)}`);
      const socketIndex = credentials.command.indexOf('--socket');
      expect(socketIndex, `command: ${credentials.command.join(' ')}`).toBeGreaterThan(0);
      expect(credentials.timeoutMs).toBe(60_000);
      const socket = credentials.command[socketIndex + 1] ?? '';
      // The socket the session was handed is the job epoch's own, and it answers that provider with the grant.
      expect(await requestProviderKey(socket, 'openrouter')).toEqual({
        ok: true, key: 'sk-or-1', expiresAt: Date.parse(w.grant.expiresAt), account: 'koda:global:fleet',
      });
    } finally {
      await w.stop();
    }
  });
});

describe('ThreadJobRun session credentials from a granted provider (US-011)', () => {
  test('a granted provider opens the session with exec credentials naming the served socket', async () => {
    const SERVED = '/run/provider-keys.sock';
    const w = await seam({ serveProviderKeys: async () => SERVED });
    try {
      await w.answerGrant();
      await waitFor(() => w.journal.getJob(jobId, leaseEpoch)?.state === 'RUNNING');
      expect(w.native[0]?.credentials).toEqual({ kind: 'exec', command: [...SELF, 'provider-cred', '--socket', SERVED], timeoutMs: 60_000 });
    } finally {
      await w.stop();
    }
  });

  test('F1: an abandon while the open is pending leaves no provider request in the real broker\'s cache', async () => {
    const SERVED = '/run/provider-keys.sock';
    let reachedModels = false;
    let unblock: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const w = await seam({
      serveProviderKeys: async () => SERVED,
      nativeModels: async () => { reachedModels = true; await blocked; return { models: ['openrouter/qwen3'], defaultModel: 'openrouter/qwen3' }; },
    });
    try {
      await waitFor(() => reachedModels);
      // The window the finding names: the row is deleted and the socket released while the session is still opening.
      await w.run.abandon();
      unblock();
      await w.starting;
      expect(w.native, 'the open must have resumed after the abandonment, or the window was never entered').toHaveLength(1);
      expect(w.cache.requests(), 'a provider request survived a job that is already gone').toEqual([]);
      expect(w.cache.state(jobId, leaseEpoch, 'openrouter', Date.now()), 'the released epoch must hold no grant').toEqual({ kind: 'pending' });
    } finally {
      await w.stop();
    }
  });
});

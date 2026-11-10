import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssignPayload, RunnerCapabilities } from '@nathapp/fleet-protocol';
import { NaxJobCheck, type JobCheck } from '../../src/capabilities/job-check';
import { RetryingJobCheck } from '../../src/capabilities/job-check-retry';
import type { CredentialProvider } from '../../src/credentials/broker';
import { PROVIDER_CRED_SOCKET_ENV } from '../../src/credentials/provider-cred';
import { createGit } from '../../src/executor/git';
import { HostExecutor } from '../../src/executor/host-executor';
import { jobProfilePath } from '../../src/executor/job-profile';
import type { SpawnHandle } from '../../src/executor/job-executor';
import type { SpawnNaxOptions } from '../../src/executor/nax-process';
import type { JobRow } from '../../src/journal/types';
import { Journal } from '../../src/journal/journal';
import { createMemoryLogger } from '../../src/logger';
import { createNaxCli } from '../../src/nax/nax-cli';
import { jobDirFor } from '../../src/paths/safe-segment';
import { isolateGit, makeOrigin } from '../helpers/git-fixture';
import { NO_APPROVALS } from '../helpers/no-approvals';
import { NO_CREDENTIALS } from '../helpers/no-credentials';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
const FAKE = join(import.meta.dir, '..', 'fixtures', 'fake-nax.ts');
const PRD = JSON.stringify({ branchName: 'feat/feat', userStories: [{ id: 'US-1' }] });
const CAPS: RunnerCapabilities = {
  nax: { version: '0.83.1-fake', protocols: ['native'] }, sandbox: { available: true, probedAt: '2026-10-01T00:00:00.000Z' },
  profiles: {}, credentials: [], tools: { git: true, gh: true, glab: false }, executors: ['host'],
};
const needs = (providers: string[], sandbox = false) => JSON.stringify({ fakeRequirements: { transport: 'native', providers, sandbox } });
const HANDLE: SpawnHandle = { pid: 4242, pgid: 4242 };
const SOCKET = '/run/koda-runner-501/cjob1-socket';
beforeAll(() => { isolateGit(); });
afterAll(() => tmp.cleanup());

/** C10: a runner whose nax config names koda's exec helper, and a broker that can (or cannot) grant `openrouter`. */
interface VaultOptions {
  /** The providers the job's provider-key socket answers with a grant. */
  readonly granted: readonly string[];
  /** Caps beyond `providerVault`, e.g. a sandbox the machine lacks. */
  readonly caps?: Partial<RunnerCapabilities>;
}

/**
 * A provider that serves and releases the job's provider-key socket and answers the vault lookup the job check asks —
 * no unix socket listens, so this runs in a sandbox that refuses socket binds (the broker's own socket is US-008's).
 */
function vaultProvider(granted: readonly string[]): { credentials: CredentialProvider; asked: string[] } {
  const asked: string[] = [];
  const credentials: CredentialProvider = {
    acquire: async () => ({ ok: true, credentials: { helper: null, binDir: null } }),
    release: async () => undefined,
    serveProviderKeys: async () => SOCKET,
    providerKeyGranted: async (_job: JobRow, providerId: string) => {
      asked.push(providerId);
      return granted.includes(providerId);
    },
    releaseProviderKeys: async () => undefined,
  };
  return { credentials, asked };
}

async function world(profiles: string[], vault?: VaultOptions, wrap: (check: JobCheck) => JobCheck = (check) => check) {
  const base = await tmp.make('jobcheck');
  const origin = await makeOrigin(base, 'origin', {
    files: {
      'README.md': 'x', '.nax/config.json': '{}\n', '.nax/features/feat/prd.json': PRD,
      '.nax/fake-profiles/needs-zai.json': needs(['zai']), '.nax/fake-profiles/needs-sandbox.json': needs([], true),
    },
  });
  const workspaceRoot = join(base, 'ws');
  const naxHome = join(base, 'naxhome');
  await mkdir(naxHome, { recursive: true });
  const assign: AssignPayload = {
    jobId: 'cjob1', command: 'RUN', repo: { provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: origin.url },
    ref: 'main', feature: 'feat', planFrom: null, profiles, maxCostUsd: '5', bashMode: 'raw', approvalTimeoutSec: 600, gitIdentity: { name: 'koda-fleet[bot]', email: 'bot@x' },
  };
  const row = Journal.open(':memory:').insertJob({ assign, leaseEpoch: 1, repoKey: 'acme/app', jobDir: jobDirFor(workspaceRoot, assign.jobId) }).row;
  const provider = vaultProvider(vault?.granted ?? []);
  const caps = { current: vault === undefined ? CAPS : { ...CAPS, providerVault: true as const, ...vault.caps } };
  const jobCheck = new NaxJobCheck({
    nax: createNaxCli(['bun', FAKE], naxHome), capabilities: () => caps.current,
    ...(vault === undefined ? {} : { providerKey: (job: JobRow, providerId: string) => provider.credentials.providerKeyGranted?.(job, providerId) ?? Promise.resolve(false) }),
  });
  /** Every nax start, recorded instead of spawned: the environment is what US-009 is about. */
  const calls: Array<{ readonly argv: readonly string[]; readonly options: SpawnNaxOptions }> = [];
  const ex = new HostExecutor({
    config: { workspaceRoot, naxCommand: ['bun', FAKE], naxHome }, git: createGit(), log: createMemoryLogger(), nowMs: () => Date.now(),
    sleep: async () => undefined, credentials: vault === undefined ? NO_CREDENTIALS : provider.credentials, approvals: NO_APPROVALS, jobCheck: wrap(jobCheck),
    spawnNax: (argv, options) => { calls.push({ argv, options }); return HANDLE; },
  });
  return { naxHome, row, ex, caps, calls, asked: provider.asked };
}

describe('HostExecutor.prepare with the job check (D104), fake nax and real git', () => {
  test('no profiles: the clone\'s default config needs nothing this machine lacks', async () => {
    const w = await world([]);
    expect(await w.ex.prepare(w.row)).toEqual({ ok: true, branch: 'feat/feat' });
  });
  test('a repo-provided profile needing a provider nax cannot serve fails before the job profile is written', async () => {
    const w = await world(['needs-zai']);
    expect(await w.ex.prepare(w.row)).toEqual({ ok: false, reason: 'capability mismatch: provider zai unavailable' });
    await expect(stat(jobProfilePath(w.naxHome, 'cjob1'))).rejects.toThrow();
  });
  test('a sandbox profile on a machine whose sandbox is unavailable fails', async () => {
    const w = await world(['needs-sandbox']);
    w.caps.current = { ...CAPS, sandbox: { available: false, error: 'bwrap', probedAt: CAPS.sandbox.probedAt } };
    expect(await w.ex.prepare(w.row)).toEqual({ ok: false, reason: 'capability mismatch: sandbox' });
  });
  test("an unknown profile fails with nax's code", async () => {
    const w = await world(['no-such-profile']);
    expect(await w.ex.prepare(w.row)).toEqual({ ok: false, reason: 'capability mismatch: profile resolve failed (PROFILE_NOT_FOUND)' });
  });
  test('Review focus 4: an untrusted clone fails with `project untrusted` before nax ever spawns', async () => {
    const w = await world([]);
    await writeFile(join(w.naxHome, 'fake-untrusted'), '');
    expect(await w.ex.prepare(w.row)).toEqual({ ok: false, reason: 'project untrusted' });
  });
});

/** #406: the first answer is a timeout, then the real check answers. */
function timesOutOnce(inner: JobCheck): JobCheck & { calls: number } {
  const check = {
    calls: 0,
    check: async (...args: Parameters<JobCheck['check']>) => {
      check.calls += 1;
      return check.calls === 1 ? 'trust check failed: NAX_TIMEOUT' : inner.check(...args);
    },
  };
  return check;
}

describe('HostExecutor.prepare with a retried job check (#406)', () => {
  test('a check that times out once passes on the retry and the job is prepared', async () => {
    let flaky: ReturnType<typeof timesOutOnce> | undefined;
    const slept: number[] = [];
    const w = await world([], undefined, (check) => {
      flaky = timesOutOnce(check);
      return new RetryingJobCheck({ inner: flaky, retries: 2, backoffMs: 2_000, sleep: async (ms) => { slept.push(ms); } });
    });
    expect(await w.ex.prepare(w.row)).toEqual({ ok: true, branch: 'feat/feat' });
    expect(flaky?.calls).toBe(2);
    expect(slept).toEqual([2_000]);
  });
  test('a cancel during the retry backoff ends prepare as cancelled, not failed', async () => {
    let cancelled = false;
    const w = await world([], undefined, (check) => new RetryingJobCheck({
      inner: timesOutOnce(check), retries: 2, backoffMs: 2_000, sleep: async () => { cancelled = true; },
    }));
    expect(await w.ex.prepare(w.row, { isCancelled: () => cancelled })).toEqual({ ok: false, reason: 'cancelled', cancelled: true });
    await expect(stat(jobProfilePath(w.naxHome, 'cjob1'))).rejects.toThrow();
  });
});

/**
 * C10 (branch review B1): the whole fleet path for a machine with no machine-local `nax auth` login — the post-checkout
 * check resolves the provider through the job's own provider-key socket, prepare accepts the job, and the spawn that
 * follows carries that socket for nax's exec helper.
 */
describe('a vault-only machine: no local login, the key comes from koda (C10)', () => {
  test('prepare passes and the spawn carries KODA_PROVIDER_CRED_SOCKET for the granted provider', async () => {
    const w = await world(['needs-zai'], { granted: ['zai'] });
    expect(await w.ex.prepare(w.row)).toEqual({ ok: true, branch: 'feat/feat' });
    expect(w.asked).toEqual(['zai']);
    await w.ex.spawn(w.row);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]?.options.env[PROVIDER_CRED_SOCKET_ENV]).toBe(SOCKET);
    expect(w.calls[0]?.options.env['PATH']).not.toBeUndefined();
  });
  test('without a grant the job still fails before nax, naming the provider', async () => {
    const w = await world(['needs-zai'], { granted: [] });
    expect(await w.ex.prepare(w.row)).toEqual({ ok: false, reason: 'capability mismatch: provider zai unavailable' });
    expect(w.calls).toEqual([]);
  });
  test('the vault does not answer what it cannot (a sandbox the machine lacks)', async () => {
    const w = await world(['needs-sandbox'], { granted: ['zai'], caps: { sandbox: { available: false, error: 'bwrap', probedAt: CAPS.sandbox.probedAt } } });
    expect(await w.ex.prepare(w.row)).toEqual({ ok: false, reason: 'capability mismatch: sandbox' });
  });
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssignPayload, RunnerCapabilities } from '@nathapp/fleet-protocol';
import { NaxJobCheck } from '../../src/capabilities/job-check';
import { createGit } from '../../src/executor/git';
import { HostExecutor } from '../../src/executor/host-executor';
import { jobProfilePath } from '../../src/executor/job-profile';
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
beforeAll(() => { isolateGit(); });
afterAll(() => tmp.cleanup());

async function world(profiles: string[]) {
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
  const caps = { current: CAPS };
  const jobCheck = new NaxJobCheck({ nax: createNaxCli(['bun', FAKE], naxHome), capabilities: () => caps.current });
  const ex = new HostExecutor({
    config: { workspaceRoot, naxCommand: ['bun', FAKE], naxHome }, git: createGit(), log: createMemoryLogger(), nowMs: () => Date.now(),
    sleep: async () => undefined, credentials: NO_CREDENTIALS, approvals: NO_APPROVALS, jobCheck,
  });
  return { naxHome, row, ex, caps };
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

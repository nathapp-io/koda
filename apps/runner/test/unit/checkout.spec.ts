import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { AssignPayload } from '@nathapp/fleet-protocol';
import { validateBranchName } from '../../src/executor/branch';
import { prepareCheckout } from '../../src/executor/checkout';
import { createGit } from '../../src/executor/git';
import { resolveRef } from '../../src/executor/refs';
import { cleanWorkspace, ensureClone } from '../../src/executor/workspace';
import { git as sh, isolateGit, makeOrigin, pushCommit, type Origin } from '../helpers/git-fixture';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
beforeAll(() => isolateGit());
afterAll(() => tmp.cleanup());
const g = createGit();
const identity = { name: 'bot', email: 'bot@x' };
const prd = (over: Record<string, unknown> = {}) => JSON.stringify({ branchName: 'feat/f', userStories: [{ id: 'US-001' }], ...over });

async function setup(files: Record<string, string> = { '.nax/features/f/prd.json': prd(), 'README.md': 'x' }, extra: Partial<Parameters<typeof makeOrigin>[2]> = {}) {
  const base = await tmp.make('co');
  const origin: Origin = await makeOrigin(base, 'origin', { files, tags: ['v1'], ...extra });
  const repoDir = join(base, 'clone');
  await ensureClone(g, { repoDir, cloneUrl: origin.url, identity });
  await cleanWorkspace(g, repoDir);
  return { base, origin, repoDir };
}
const assign = (over: Partial<AssignPayload> = {}): AssignPayload => ({
  jobId: 'j1', command: 'RUN', repo: { provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: 'x' },
  ref: 'main', feature: 'f', planFrom: null, profiles: [], maxCostUsd: '5', bashMode: 'raw', approvalTimeoutSec: 600, gitIdentity: identity, ...over,
});
const head = (repoDir: string) => sh(repoDir, 'rev-parse', 'HEAD');
const branchOf = (repoDir: string) => sh(repoDir, 'symbolic-ref', '--short', 'HEAD');

describe('resolveRef (design §2 step 3)', () => {
  test('prefers origin/<ref>, then a tag or commit', async () => {
    const { repoDir, origin, base } = await setup();
    const tip = await sh(repoDir, 'rev-parse', 'origin/main');
    expect(await resolveRef(g, repoDir, 'main')).toEqual({ ok: true, sha: tip, kind: 'remote-branch' });
    expect(await resolveRef(g, repoDir, 'v1')).toEqual({ ok: true, sha: tip, kind: 'other' });
    expect(await resolveRef(g, repoDir, tip)).toEqual({ ok: true, sha: tip, kind: 'other' });
    const advanced = await pushCommit(base, origin.url, 'main', 'n', '1');
    await cleanWorkspace(g, repoDir);
    expect(await resolveRef(g, repoDir, 'main')).toMatchObject({ ok: true, sha: advanced });
  });
  test('an unknown ref is not-found; option-shaped and odd refs are invalid (D31)', async () => {
    const { repoDir } = await setup();
    expect(await resolveRef(g, repoDir, 'no-such-branch')).toEqual({ ok: false, reason: 'not-found' });
    for (const ref of ['-x', '--upload-pack=sh', 'a..b', 'HEAD:README.md', 'a b', '', '/x', 'x/', 'a//b', 'x.lock', '@{-1}']) {
      expect(await resolveRef(g, repoDir, ref)).toEqual({ ok: false, reason: 'invalid' });
    }
  });
});

describe('validateBranchName', () => {
  test('accepts a feature branch and refuses the default branch, main, master and hostile shapes', async () => {
    const { repoDir } = await setup();
    expect(await validateBranchName(g, repoDir, 'feat/f', 'main')).toBe(true);
    for (const name of ['main', 'master', 'trunk', '-x', 'a..b', '@{-1}', '', 'a b', 'x.lock', 'a~1', 'a^b', 'a:b', '/x', 'x/']) {
      expect(await validateBranchName(g, repoDir, name, 'trunk')).toBe(false);
    }
  });
});

describe('prepareCheckout RUN: the five branch cases (R-3.3)', () => {
  test('neither branch exists: creates it from the ref', async () => {
    const { repoDir } = await setup();
    const result = await prepareCheckout({ git: g, repoDir, assign: assign() });
    expect(result).toMatchObject({ ok: true, branch: 'feat/f' });
    expect(await branchOf(repoDir)).toBe('feat/f');
    expect(await head(repoDir)).toBe(await sh(repoDir, 'rev-parse', 'origin/main'));
  });
  test('only origin has it: continues the origin branch (ref only supplies the branch name)', async () => {
    const { repoDir } = await setup(undefined, { branches: [{ name: 'feat/f', files: { 'from-origin.txt': '1' } }] });
    expect(await prepareCheckout({ git: g, repoDir, assign: assign() })).toMatchObject({ ok: true, branch: 'feat/f' });
    expect(await head(repoDir)).toBe(await sh(repoDir, 'rev-parse', 'origin/feat/f'));
  });
  test('both exist and origin is behind local: keeps the unpushed local commits', async () => {
    const { repoDir } = await setup(undefined, { branches: [{ name: 'feat/f', files: { 'from-origin.txt': '1' } }] });
    await prepareCheckout({ git: g, repoDir, assign: assign() });
    await sh(repoDir, 'commit', '-q', '--allow-empty', '-m', 'unpushed run commit');
    const local = await head(repoDir);
    await cleanWorkspace(g, repoDir);
    expect(await prepareCheckout({ git: g, repoDir, assign: assign() })).toMatchObject({ ok: true });
    expect(await head(repoDir)).toBe(local);
  });
  test('both exist and local is behind origin: fast-forwards to origin', async () => {
    const { repoDir, origin, base } = await setup(undefined, { branches: [{ name: 'feat/f', files: { 'a': '1' } }] });
    await prepareCheckout({ git: g, repoDir, assign: assign() });
    const advanced = await pushCommit(base, origin.url, 'feat/f', 'b', '2');
    await cleanWorkspace(g, repoDir);
    await prepareCheckout({ git: g, repoDir, assign: assign() });
    expect(await head(repoDir)).toBe(advanced);
  });
  test('both exist and diverged: FAILED, and nothing is discarded', async () => {
    const { repoDir, origin, base } = await setup(undefined, { branches: [{ name: 'feat/f', files: { 'a': '1' } }] });
    await prepareCheckout({ git: g, repoDir, assign: assign() });
    await sh(repoDir, 'commit', '-q', '--allow-empty', '-m', 'local only');
    const local = await head(repoDir);
    await pushCommit(base, origin.url, 'feat/f', 'c', '3');
    await cleanWorkspace(g, repoDir);
    expect(await prepareCheckout({ git: g, repoDir, assign: assign() })).toEqual({ ok: false, reason: 'checkout: branch diverged' });
    expect(await head(repoDir)).toBe(local);
  });
  test('only a local branch exists (never pushed): keeps it', async () => {
    const { repoDir } = await setup({ '.nax/features/f/prd.json': prd({ branchName: 'feat/local-only' }) });
    await prepareCheckout({ git: g, repoDir, assign: assign() });
    await sh(repoDir, 'commit', '-q', '--allow-empty', '-m', 'first run');
    const local = await head(repoDir);
    await sh(repoDir, 'checkout', '-q', 'main');
    expect(await prepareCheckout({ git: g, repoDir, assign: assign() })).toMatchObject({ ok: true, branch: 'feat/local-only' });
    expect(await head(repoDir)).toBe(local);
  });
});

describe('prepareCheckout RUN: bad PRDs and refs (fixed reasons, D32)', () => {
  test.each([
    ['no prd.json at the ref', { 'README.md': 'x' }, 'checkout: no prd.json at ref'],
    ['prd.json is not JSON', { '.nax/features/f/prd.json': 'nope' }, 'checkout: prd.json is not valid JSON'],
    ['no branchName', { '.nax/features/f/prd.json': '{"userStories":[]}' }, 'checkout: prd.json has no branchName'],
    ['branchName is the default branch', { '.nax/features/f/prd.json': prd({ branchName: 'main' }) }, 'checkout: invalid branchName'],
    ['branchName is master', { '.nax/features/f/prd.json': prd({ branchName: 'master' }) }, 'checkout: invalid branchName'],
    ['branchName starts with a dash', { '.nax/features/f/prd.json': prd({ branchName: '-x' }) }, 'checkout: invalid branchName'],
    ['branchName has ..', { '.nax/features/f/prd.json': prd({ branchName: 'a..b' }) }, 'checkout: invalid branchName'],
    ['branchName is @{-1}', { '.nax/features/f/prd.json': prd({ branchName: '@{-1}' }) }, 'checkout: invalid branchName'],
  ])('%s', async (_label, files, reason) => {
    const { repoDir } = await setup(files as Record<string, string>);
    expect(await prepareCheckout({ git: g, repoDir, assign: assign() })).toEqual({ ok: false, reason });
  });
  test('an unknown or hostile ref is a fixed reason', async () => {
    const { repoDir } = await setup();
    expect(await prepareCheckout({ git: g, repoDir, assign: assign({ ref: 'nope' }) })).toEqual({ ok: false, reason: 'checkout: ref not found' });
    expect(await prepareCheckout({ git: g, repoDir, assign: assign({ ref: '--upload-pack=x' }) })).toEqual({ ok: false, reason: 'checkout: invalid ref' });
  });
  test('a tag and a sha work as the ref', async () => {
    const { repoDir } = await setup();
    const tip = await sh(repoDir, 'rev-parse', 'origin/main');
    expect(await prepareCheckout({ git: g, repoDir, assign: assign({ ref: 'v1' }) })).toMatchObject({ ok: true, refSha: tip });
    await sh(repoDir, 'checkout', '-q', 'main');
    await sh(repoDir, 'branch', '-D', 'feat/f');
    expect(await prepareCheckout({ git: g, repoDir, assign: assign({ ref: tip }) })).toMatchObject({ ok: true, refSha: tip });
  });
});

describe('prepareCheckout PLAN', () => {
  const plan = (over: Partial<AssignPayload> = {}) => assign({ command: 'PLAN', planFrom: 'docs/spec.md', ...over });
  test('checks out the ref detached', async () => {
    const { repoDir } = await setup();
    const result = await prepareCheckout({ git: g, repoDir, assign: plan() });
    expect(result).toMatchObject({ ok: true, branch: null });
    expect((await sh(repoDir, 'rev-parse', '--abbrev-ref', 'HEAD'))).toBe('HEAD');
    expect(await head(repoDir)).toBe(await sh(repoDir, 'rev-parse', 'origin/main'));
  });
  test('a repo without .nax/ is FAILED with the fixed reason', async () => {
    const { repoDir } = await setup({ 'README.md': 'x' });
    expect(await prepareCheckout({ git: g, repoDir, assign: plan() })).toEqual({ ok: false, reason: 'no .nax dir' });
  });
});

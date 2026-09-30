import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGit, NO_CREDENTIALS_REASON, type Git, type GitResult } from '../../src/executor/git';
import { commitAndPushPlan, PLAN_PUSH_BACKOFF_MS, stashPlanOutputs } from '../../src/executor/plan-commit';
import { cleanWorkspace, ensureClone } from '../../src/executor/workspace';
import { git as sh, isolateGit, makeOrigin, pushCommit } from '../helpers/git-fixture';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
beforeAll(() => isolateGit());
afterAll(() => tmp.cleanup());
const g = createGit();
const identity = { name: 'koda-fleet[bot]', email: 'koda-fleet[bot]@users.noreply.github.com' };
const NEW_PRD = JSON.stringify({ feature: 'f', branchName: 'feat/f', userStories: [{ id: 'US-001' }] });

async function setup(files: Record<string, string> = { 'README.md': 'x' }, extra: Parameters<typeof makeOrigin>[2]['branches'] = []) {
  const base = await tmp.make('plan');
  const origin = await makeOrigin(base, 'origin', { files, branches: extra });
  const repoDir = join(base, 'clone');
  const jobDir = join(base, 'job');
  await ensureClone(g, { repoDir, cloneUrl: origin.url, identity });
  await cleanWorkspace(g, repoDir);
  await sh(repoDir, 'checkout', '-q', '--detach', 'origin/main');
  return { base, origin, repoDir, jobDir, refSha: await sh(repoDir, 'rev-parse', 'HEAD') };
}
/** What `nax plan` leaves behind: untracked outputs beside decoys that must never be committed. */
async function planOutputs(repoDir: string, prd = NEW_PRD): Promise<void> {
  const dir = join(repoDir, '.nax', 'features', 'f');
  await mkdir(join(dir, 'plan'), { recursive: true });
  await mkdir(join(dir, 'sessions'), { recursive: true });
  await writeFile(join(dir, 'prd.json'), prd);
  await writeFile(join(dir, 'spec.md'), '# spec\n');
  await writeFile(join(dir, 'prd-fidelity-report.md'), '# fidelity\n');
  await writeFile(join(dir, 'acceptance-meta.json'), '{}');
  await writeFile(join(dir, 'prd.rejected.json'), '{"old":true}');
  await writeFile(join(dir, 'plan', 'plan-1.jsonl'), '{"m":1}\n');
  await writeFile(join(dir, 'sessions', 's1.json'), '{}');
}
const noSleep = async (): Promise<void> => undefined;
/** Real git, except that `push` is counted and, when `pushResult` is given, answered without running. */
function countingGit(pushResult?: GitResult): { git: Git; pushes: () => number } {
  let count = 0;
  const run: Git['run'] = async (args, options) => {
    if (args[0] !== 'push') return g.run(args, options);
    count += 1;
    return pushResult ?? g.run(args, options);
  };
  return { git: { run, ok: g.ok }, pushes: () => count };
}
const input = (s: Awaited<ReturnType<typeof setup>>, over: Record<string, unknown> = {}) => ({
  git: g, repoDir: s.repoDir, jobDir: s.jobDir, feature: 'f', jobId: 'j1', branchName: 'feat/f', refSha: s.refSha, defaultBranch: 'main', identity, ...over,
});

describe('stashPlanOutputs', () => {
  test('copies the allowlisted files and the plan logs, nothing else', async () => {
    const s = await setup();
    await planOutputs(s.repoDir);
    const stashed = await stashPlanOutputs(s.repoDir, s.jobDir, 'f');
    expect(stashed.files.sort()).toEqual(['acceptance-meta.json', 'prd-fidelity-report.md', 'prd.json', 'spec.md']);
    expect(stashed.logs).toEqual(['plan-1.jsonl']);
    expect(await readFile(join(s.jobDir, 'plan-logs', 'plan-1.jsonl'), 'utf8')).toBe('{"m":1}\n');
    await expect(stat(join(s.jobDir, 'plan-out', 'prd.rejected.json'))).rejects.toThrow();
    await expect(stat(join(s.jobDir, 'plan-out', 's1.json'))).rejects.toThrow();
  });
  test('an absent feature directory stashes nothing and publishes no plan-out', async () => {
    const s = await setup();
    expect(await stashPlanOutputs(s.repoDir, s.jobDir, 'f')).toEqual({ files: [], logs: [] });
    await expect(stat(join(s.jobDir, 'plan-out'))).rejects.toThrow();
  });
  test('is write-once (D61): a second call returns the first stash and never re-reads the checkout', async () => {
    const s = await setup();
    await planOutputs(s.repoDir);
    const first = await stashPlanOutputs(s.repoDir, s.jobDir, 'f');
    await writeFile(join(s.repoDir, '.nax', 'features', 'f', 'prd.json'), '{"replaced":true}');
    await rm(join(s.repoDir, '.nax', 'features', 'f', 'spec.md'));
    const second = await stashPlanOutputs(s.repoDir, s.jobDir, 'f');
    expect(second.files.sort()).toEqual(first.files.sort());
    expect(second.logs).toEqual(first.logs);
    expect(await readFile(join(s.jobDir, 'plan-out', 'prd.json'), 'utf8')).toBe(NEW_PRD);
    expect(await readFile(join(s.jobDir, 'plan-out', 'spec.md'), 'utf8')).toBe('# spec\n');
  });
  test('a stash interrupted before the rename leaves no plan-out and is rebuilt', async () => {
    const s = await setup();
    await planOutputs(s.repoDir);
    await mkdir(join(s.jobDir, 'plan-out.tmp'), { recursive: true });
    await writeFile(join(s.jobDir, 'plan-out.tmp', 'prd.json'), 'half written');
    const stashed = await stashPlanOutputs(s.repoDir, s.jobDir, 'f');
    expect(stashed.files).toContain('prd.json');
    expect(await readFile(join(s.jobDir, 'plan-out', 'prd.json'), 'utf8')).toBe(NEW_PRD);
    await expect(stat(join(s.jobDir, 'plan-out.tmp'))).rejects.toThrow();
  });
});

describe('commitAndPushPlan', () => {
  test('creates the branch from the ref, commits only the allowlist as the assigned identity, and pushes', async () => {
    const s = await setup();
    await planOutputs(s.repoDir);
    // No identity anywhere but the input: the commit must pass it explicitly (D69).
    await sh(s.repoDir, 'config', '--unset', 'user.name');
    await sh(s.repoDir, 'config', '--unset', 'user.email');
    const keys = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
    const saved = keys.map((k) => [k, process.env[k]] as const);
    for (const k of keys) delete process.env[k];
    try {
      const result = await commitAndPushPlan(input(s));
      expect(result).toMatchObject({ ok: true, branch: 'feat/f', committed: true });
      const sha = (result as { sha: string }).sha;
      expect(await sh(s.origin.dir, 'rev-parse', 'feat/f')).toBe(sha);
      expect(await sh(s.origin.dir, 'log', '-1', '--format=%an <%ae>|%s', 'feat/f')).toBe(`${identity.name} <${identity.email}>|chore(plan): f PRD via koda job j1`);
    } finally {
      for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
    }
    const files = (await sh(s.origin.dir, 'ls-tree', '-r', '--name-only', 'feat/f')).split('\n').sort();
    expect(files).toEqual(['.nax/features/f/acceptance-meta.json', '.nax/features/f/prd-fidelity-report.md', '.nax/features/f/prd.json', '.nax/features/f/spec.md', 'README.md']);
    expect(await sh(s.origin.dir, 'rev-parse', 'feat/f~1')).toBe(s.refSha);
  });
  test('a tracked stale PRD at the ref is replaced by the new one', async () => {
    const s = await setup({ 'README.md': 'x', '.nax/features/f/prd.json': '{"old":true,"userStories":[{"id":"OLD"}]}' });
    await planOutputs(s.repoDir);
    const result = await commitAndPushPlan(input(s));
    expect(result).toMatchObject({ ok: true });
    expect(JSON.parse(await sh(s.origin.dir, 'show', 'feat/f:.nax/features/f/prd.json')).branchName).toBe('feat/f');
  });
  test('crash after `checkout -f -B` and before the copy-back: the retry commits the stashed PRD, not the ref\'s stale one (D61)', async () => {
    const s = await setup({ 'README.md': 'x', '.nax/features/f/prd.json': '{"old":true,"userStories":[{"id":"OLD"}]}' });
    await planOutputs(s.repoDir);
    await stashPlanOutputs(s.repoDir, s.jobDir, 'f');                       // what the first attempt did before the switch
    await sh(s.repoDir, 'checkout', '-q', '-f', '-B', 'feat/f', s.refSha);   // ... and the crash: the tracked PRD is the old one again
    expect(await readFile(join(s.repoDir, '.nax', 'features', 'f', 'prd.json'), 'utf8')).toContain('OLD');
    const result = await commitAndPushPlan(input(s));
    expect(result).toMatchObject({ ok: true, committed: true });
    const pushed = JSON.parse(await sh(s.origin.dir, 'show', 'feat/f:.nax/features/f/prd.json'));
    expect(pushed.branchName).toBe('feat/f');
    expect(pushed.userStories[0].id).toBe('US-001');
  });
  test('is idempotent: after the push retries run out, a later call pushes the kept commit without a second one', async () => {
    const s = await setup();
    await planOutputs(s.repoDir);
    await sh(s.repoDir, 'remote', 'set-url', 'origin', `file://${join(s.base, 'nowhere.git')}`);
    const failed = await commitAndPushPlan(input(s, { sleep: noSleep }));
    expect(failed).toEqual({ ok: false, reason: 'plan push failed' });
    const local = await sh(s.repoDir, 'rev-parse', 'feat/f');
    expect(local).not.toBe(s.refSha);                        // the commit is kept locally
    await sh(s.repoDir, 'remote', 'set-url', 'origin', s.origin.url);
    await cleanWorkspace(g, s.repoDir);
    const again = await commitAndPushPlan(input(s));
    expect(again).toMatchObject({ ok: true, committed: false, sha: local });
    expect(await sh(s.origin.dir, 'rev-parse', 'feat/f')).toBe(local);
    expect(await commitAndPushPlan(input(s))).toMatchObject({ ok: true, committed: false, sha: local });
  });
  test('D77: a transient push failure is retried after a back-off and succeeds with one commit', async () => {
    const s = await setup();
    await planOutputs(s.repoDir);
    await sh(s.repoDir, 'remote', 'set-url', 'origin', `file://${join(s.base, 'nowhere.git')}`);
    const waits: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      waits.push(ms);
      await sh(s.repoDir, 'remote', 'set-url', 'origin', s.origin.url);   // the network comes back during the back-off
    };
    const result = await commitAndPushPlan(input(s, { sleep }));
    expect(result).toMatchObject({ ok: true, committed: true });
    expect(waits).toEqual([PLAN_PUSH_BACKOFF_MS[0]]);
    expect(await sh(s.origin.dir, 'rev-parse', 'feat/f~1')).toBe(s.refSha);   // exactly one plan commit on the ref
  });
  test('D77: a push that keeps failing is tried once per back-off step plus once, then fails', async () => {
    const s = await setup();
    await planOutputs(s.repoDir);
    await sh(s.repoDir, 'remote', 'set-url', 'origin', `file://${join(s.base, 'nowhere.git')}`);
    const { git, pushes } = countingGit();
    const waits: number[] = [];
    const result = await commitAndPushPlan(input(s, { git, sleep: async (ms: number) => { waits.push(ms); } }));
    expect(result).toEqual({ ok: false, reason: 'plan push failed' });
    expect(pushes()).toBe(PLAN_PUSH_BACKOFF_MS.length + 1);
    expect(waits).toEqual([...PLAN_PUSH_BACKOFF_MS]);
  });
  test('D77: an auth failure is not retried', async () => {
    const s = await setup();
    await planOutputs(s.repoDir);
    const { git, pushes } = countingGit({ code: 128, stdout: '', stderr: 'fatal: Authentication failed for https://x' });
    const waits: number[] = [];
    const result = await commitAndPushPlan(input(s, { git, sleep: async (ms: number) => { waits.push(ms); } }));
    expect(result).toEqual({ ok: false, reason: NO_CREDENTIALS_REASON });
    expect(pushes()).toBe(1);
    expect(waits).toEqual([]);
  });
  test('continues an existing origin branch on top of its tip (fast-forward push)', async () => {
    const s = await setup({ 'README.md': 'x' }, [{ name: 'feat/f', files: { 'older.txt': '1' } }]);
    await planOutputs(s.repoDir);
    const tip = await sh(s.origin.dir, 'rev-parse', 'feat/f');
    const result = await commitAndPushPlan(input(s));
    expect(result).toMatchObject({ ok: true, committed: true });
    expect(await sh(s.origin.dir, 'rev-parse', 'feat/f~1')).toBe(tip);
  });
  test('a diverged branch fails without pushing or discarding', async () => {
    const s = await setup({ 'README.md': 'x' }, [{ name: 'feat/f', files: { 'older.txt': '1' } }]);
    await sh(s.repoDir, 'checkout', '-q', '-B', 'feat/f', 'origin/feat/f');
    await sh(s.repoDir, 'commit', '-q', '--allow-empty', '-m', 'local only');
    const local = await sh(s.repoDir, 'rev-parse', 'HEAD');
    await pushCommit(s.base, s.origin.url, 'feat/f', 'other.txt', '2');
    await cleanWorkspace(g, s.repoDir);
    await sh(s.repoDir, 'checkout', '-q', '--detach', s.refSha);
    await planOutputs(s.repoDir);
    expect(await commitAndPushPlan(input(s))).toEqual({ ok: false, reason: 'checkout: branch diverged' });
    expect(await sh(s.repoDir, 'rev-parse', 'feat/f')).toBe(local);
  });
  test.each(['main', 'master', '-x', 'a..b', '@{-1}'])('refuses the branch name %s', async (branchName) => {
    const s = await setup();
    await planOutputs(s.repoDir);
    expect(await commitAndPushPlan(input(s, { branchName }))).toEqual({ ok: false, reason: 'checkout: invalid branchName' });
  });
  test('no PRD in the feature directory is a fixed failure', async () => {
    const s = await setup();
    expect(await commitAndPushPlan(input(s))).toEqual({ ok: false, reason: 'plan output missing' });
  });
});

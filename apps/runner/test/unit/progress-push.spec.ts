import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGit, NO_CREDENTIALS_REASON, type Git, type GitResult } from '../../src/executor/git';
import { PLAN_PUSH_BACKOFF_MS } from '../../src/executor/plan-commit';
import { pushProgress, wipPushValue, type ProgressPushInput } from '../../src/executor/progress-push';
import { git as sh, isolateGit, makeOrigin, pushCommit } from '../helpers/git-fixture';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
beforeAll(() => isolateGit());
afterAll(() => tmp.cleanup());
const g = createGit();
const identity = { name: 'koda-fleet[bot]', email: 'koda-fleet[bot]@users.noreply.github.com' };
const PRD = '.nax/features/f/prd.json';
const prdText = (status: string) => `${JSON.stringify({ feature: 'f', branchName: 'feat/f', userStories: [{ id: 'US-001', status }] })}\n`;
const noSleep = async (): Promise<void> => undefined;

/** A clone on `feat/f` (tracking origin) with one local story commit, like a RUN nax just left behind. */
async function setup() {
  const base = await tmp.make('wip');
  const origin = await makeOrigin(base, 'origin', { files: { 'README.md': 'x', [PRD]: prdText('pending') }, branches: [{ name: 'feat/f', files: { 'branch.txt': 'b\n' } }] });
  const repoDir = join(base, 'clone');
  await sh(base, 'clone', '-q', origin.url, repoDir);
  await sh(repoDir, 'checkout', '-q', '-B', 'feat/f', 'origin/feat/f');
  await writeFile(join(repoDir, 'story.txt'), 'work\n');
  await sh(repoDir, 'add', 'story.txt');
  await sh(repoDir, '-c', 'user.name=n', '-c', 'user.email=e@x', 'commit', '-q', '-m', 'feat(f): story work');
  const input: ProgressPushInput = { git: g, repoDir, feature: 'f', jobId: 'job-1', branchName: 'feat/f', identity, sleep: noSleep };
  return { base, origin, repoDir, input };
}
function scriptedPush(results: GitResult[]): { git: Git; pushes: () => number } {
  let count = 0;
  const run: Git['run'] = async (args, options) => {
    if (args[0] !== 'push') return g.run(args, options);
    count += 1;
    return results.shift() ?? { code: 1, stdout: '', stderr: 'fatal: unable to access' };
  };
  return { git: { run, ok: g.ok }, pushes: () => count };
}

describe('pushProgress', () => {
  test('pushes the local story commits; no PRD change means no extra commit', async () => {
    const s = await setup();
    const out = await pushProgress(s.input);
    const tip = await sh(s.origin.dir, 'rev-parse', 'feat/f');
    expect(out).toEqual({ kind: 'pushed', branch: 'feat/f', sha: tip });
    expect(await sh(s.origin.dir, 'log', '-1', '--format=%s', 'feat/f')).toBe('feat(f): story work');
  });

  test('commits only prd.json, as the job identity, with the progress message', async () => {
    const s = await setup();
    await writeFile(join(s.repoDir, PRD), prdText('passed'));
    await writeFile(join(s.repoDir, 'half-done.ts'), 'export const x = 1;\n');      // uncommitted story code
    await writeFile(join(s.repoDir, 'README.md'), 'edited\n');                         // tracked, dirty, not ours
    await mkdir(join(s.repoDir, 'staged'), { recursive: true });
    await writeFile(join(s.repoDir, 'staged', 'a.txt'), 'a\n');
    await sh(s.repoDir, 'add', 'staged/a.txt');                                         // staged by someone else
    const out = await pushProgress(s.input);
    expect(out.kind).toBe('pushed');
    expect(await sh(s.origin.dir, 'log', '-1', '--format=%s|%an|%ae', 'feat/f')).toBe(`chore(nax): progress of f via koda job job-1|${identity.name}|${identity.email}`);
    expect(await sh(s.origin.dir, 'show', '--name-only', '--format=', 'feat/f')).toBe(PRD);
    expect(await sh(s.origin.dir, 'show', `feat/f:${PRD}`)).toBe(prdText('passed').trim());
  });

  test('an already-published branch returns none with its branch and SHA for recovery', async () => {
    const s = await setup();
    await sh(s.repoDir, 'push', '-q', 'origin', 'feat/f');
    const tip = await sh(s.origin.dir, 'rev-parse', 'feat/f');
    expect(await pushProgress(s.input)).toEqual({ kind: 'none', branch: 'feat/f', sha: tip });
  });

  test('non-fast-forward is failed:diverged and is not retried', async () => {
    const s = await setup();
    await pushCommit(s.base, s.origin.url, 'feat/f', 'other.txt', 'someone else\n');
    let pushes = 0;
    const counted: Git = { run: async (args, o) => { if (args[0] === 'push') pushes += 1; return g.run(args, o); }, ok: g.ok };
    const out = await pushProgress({ ...s.input, git: counted });   // a real push: the rejection text is git's own
    expect(out).toEqual({ kind: 'failed', reason: 'diverged' });
    expect(pushes).toBe(1);
  });

  test('an auth failure is not retried', async () => {
    const s = await setup();
    const scripted = scriptedPush([{ code: 128, stdout: '', stderr: 'fatal: Authentication failed for https://x' }]);
    expect(await pushProgress({ ...s.input, git: scripted.git })).toEqual({ kind: 'failed', reason: NO_CREDENTIALS_REASON });
    expect(scripted.pushes()).toBe(1);
  });

  test('a transient failure is retried on the PLAN back-off schedule, then fails', async () => {
    const s = await setup();
    const waits: number[] = [];
    const scripted = scriptedPush([]);
    const out = await pushProgress({ ...s.input, git: scripted.git, sleep: async (ms) => { waits.push(ms); } });
    expect(out).toEqual({ kind: 'failed', reason: 'push failed' });
    expect(scripted.pushes()).toBe(PLAN_PUSH_BACKOFF_MS.length + 1);
    expect(waits).toEqual([...PLAN_PUSH_BACKOFF_MS]);
  });

  test('a transient failure then success is pushed', async () => {
    const s = await setup();
    let first = true;
    const run: Git['run'] = async (args, o) => {
      if (args[0] === 'push' && first) { first = false; return { code: 1, stdout: '', stderr: 'fatal: unable to access' }; }
      return g.run(args, o);
    };
    expect((await pushProgress({ ...s.input, git: { run, ok: g.ok } })).kind).toBe('pushed');
  });

  test('a halt before or between attempts stops the push', async () => {
    const s = await setup();
    let halted = false;
    const scripted = scriptedPush([]);
    const out = await pushProgress({ ...s.input, git: scripted.git, isHalted: () => halted, sleep: async () => { halted = true; } });
    expect(out).toEqual({ kind: 'halted' });
    expect(scripted.pushes()).toBe(1);
  });

  test('refuses when HEAD is not the job branch', async () => {
    const s = await setup();
    await sh(s.repoDir, 'checkout', '-q', '--detach');
    expect(await pushProgress(s.input)).toEqual({ kind: 'failed', reason: 'not on branch' });
  });
});

describe('wipPushValue', () => {
  test('maps each outcome to its snapshot value', () => {
    expect(wipPushValue({ kind: 'pushed', branch: 'b', sha: 'a'.repeat(40) })).toBe('pushed');
    expect(wipPushValue({ kind: 'none', branch: 'b', sha: 'a'.repeat(40) })).toBe('none');
    expect(wipPushValue({ kind: 'failed', reason: 'diverged' })).toBe('failed:diverged');
    expect(wipPushValue({ kind: 'failed', reason: `x${'y'.repeat(300)}` })).toHaveLength('failed:'.length + 200);
    expect(wipPushValue({ kind: 'failed', reason: 'bad\nx' })).toBe('failed:bad?x');   // the API drops non-printable values
  });
});

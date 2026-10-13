import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGit, GitError, type Git } from '../../src/executor/git';
import { threadDirFor, threadWorktreeDir } from '../../src/thread/thread-paths';
import { discardThreadChanges, type DiscardThreadChangesInput } from '../../src/thread/thread-discard';
import { git, isolateGit, makeOrigin, type Origin } from '../helpers/git-fixture';

/** Real git: Discard resets and re-detaches one thread's worktree, so the fixture is a real clone plus a real worktree. */
let root: string;
let origin: Origin;
let repoDir: string;
let homeDir: string;
let worktree: string;
const threadId = 't1';
const feature = 'divide';

const discard = (overrides: Partial<DiscardThreadChangesInput> = {}) => discardThreadChanges({
  git: createGit(), homeDir, repoDir, threadId, feature, baseRef: 'main', ...overrides,
});

const exists = (path: string): Promise<boolean> => readFile(path).then(() => true, () => false);

beforeEach(async () => {
  isolateGit();
  root = await mkdtemp(join(tmpdir(), 'thread-discard-'));
  origin = await makeOrigin(root, 'origin', {
    files: { 'README.md': 'seed\n', '.gitignore': 'debug.log\n' },
    branches: [{ name: 'feat/divide', files: { 'docs/divide.md': 'divide\n' } }],
  });
  repoDir = join(root, 'repo');
  homeDir = join(root, 'home');
  worktree = threadWorktreeDir(homeDir, threadId);
  await git(root, 'clone', '-q', origin.url, repoDir);
  await mkdir(threadDirFor(homeDir, threadId), { recursive: true });
  await git(repoDir, 'worktree', 'add', '--detach', worktree, 'origin/main');
});

afterEach(async () => rm(root, { recursive: true, force: true }));

test('US-005 AC-8: removes an untracked allowlisted file from the worktree', async () => {
  await mkdir(join(worktree, 'docs'), { recursive: true });
  await writeFile(join(worktree, 'docs/a.md'), 'draft\n');
  expect((await discard()).ok).toBe(true);
  expect(await exists(join(worktree, 'docs/a.md'))).toBe(false);
});

test('US-005 AC-9: restores a tracked file the worktree has edited', async () => {
  await writeFile(join(worktree, 'README.md'), 'edited\n');
  expect((await discard()).ok).toBe(true);
  expect(await readFile(join(worktree, 'README.md'), 'utf8')).toBe('seed\n');
});

test('US-005 AC-10: leaves an ignored file in the worktree', async () => {
  await writeFile(join(worktree, 'debug.log'), 'keep me\n');
  expect((await discard()).ok).toBe(true);
  expect(await readFile(join(worktree, 'debug.log'), 'utf8')).toBe('keep me\n');
});

test('US-005 AC-11: returns the feature branch tip as tipSha', async () => {
  await git(repoDir, 'branch', `feat/${feature}`, 'origin/feat/divide');
  const tip = await git(repoDir, 'rev-parse', `refs/heads/feat/${feature}`);
  expect(await discard()).toEqual({ ok: true, tipSha: tip });
});

test('US-005 AC-12: re-detaches the worktree at the feature branch tip', async () => {
  await git(repoDir, 'branch', `feat/${feature}`, 'origin/feat/divide');
  const tip = await git(repoDir, 'rev-parse', `refs/heads/feat/${feature}`);
  await discard();
  expect(await git(worktree, 'rev-parse', 'HEAD')).toBe(tip);
});

test('US-005 AC-13: without a feature branch, re-detaches at origin/<baseRef>', async () => {
  const base = await git(repoDir, 'rev-parse', 'origin/main');
  expect(await discard()).toEqual({ ok: true, tipSha: base });
  expect(await git(worktree, 'rev-parse', 'HEAD')).toBe(base);
});

test('US-005 AC-14: a thread with no worktree directory is no_worktree', async () => {
  const result = await discard({ threadId: 't2' });
  expect(result).toEqual({ ok: false, reason: 'no_worktree' });
});

test('US-005 AC-15: a directory with only an empty .git inside another work tree is no_worktree and touches nothing', async () => {
  const other = join(root, 'other');
  await mkdir(other, { recursive: true });
  await git(other, 'init', '-q', '-b', 'main');
  await writeFile(join(other, 'seed.md'), 'seed\n');
  await git(other, 'add', 'seed.md');
  await git(other, 'commit', '-q', '-m', 'seed');
  await writeFile(join(other, 'keep.md'), 'keep\n');
  const fakeHome = join(other, 'home');
  const fakeWorktree = threadWorktreeDir(fakeHome, threadId);
  await mkdir(join(fakeWorktree, '.git'), { recursive: true });
  const result = await discard({ homeDir: fakeHome });
  expect(result).toEqual({ ok: false, reason: 'no_worktree' });
  expect(await readFile(join(other, 'keep.md'), 'utf8')).toBe('keep\n');
});

test('US-005 discard: an unresolvable base ref is git_error with a detail', async () => {
  const result = await discard({ baseRef: 'no-such-ref' });
  expect(result).toEqual({ ok: false, reason: 'git_error', detail: 'checkout: ref not found' });
});

test('US-005 discard: a failing git call is git_error with a sanitized detail', async () => {
  const real = createGit();
  const run: Git['run'] = async (args, options) => {
    if (args[0] === 'clean') return { code: 1, stdout: '', stderr: 'fatal: clean refused token=ghp_abcdefghijklmnopqrstuvwxyz' };
    return real.run(args, options);
  };
  const failing: Git = {
    run,
    async ok(args, options) {
      const result = await run(args, options);
      if (result.code !== 0) throw new GitError(args, result);
      return result.stdout;
    },
  };
  const result = await discard({ git: failing });
  expect(result).toMatchObject({ ok: false, reason: 'git_error' });
  if (result.ok) throw new Error('discard must fail');
  expect(result.detail).toContain('clean');
  expect(result.detail).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
});

test('US-005 discard F1: a git that cannot start while checking the worktree is git_error, not no_worktree', async () => {
  const real = createGit();
  const spawnFailure = Object.assign(new Error('Executable not found in $PATH: "git"'), { code: 'ENOENT', errno: -2, path: 'git' });
  const failing: Git = {
    run: real.run,
    async ok(args, options) {
      if (args[0] === 'rev-parse') throw spawnFailure;
      return real.ok(args, options);
    },
  };
  const result = await discard({ git: failing });
  expect(result).toMatchObject({ ok: false, reason: 'git_error' });
  if (result.ok) throw new Error('discard must fail');
  expect(result.detail).toContain('Executable not found');
  expect(await exists(join(worktree, '.git'))).toBe(true);
});

test('US-005 discard F1: a worktree check killed at its timeout is git_error, not no_worktree', async () => {
  const real = createGit();
  const failing: Git = {
    run: real.run,
    async ok(args, options) {
      if (args[0] === 'rev-parse') throw new GitError(args, { code: 137, stdout: '', stderr: '' });
      return real.ok(args, options);
    },
  };
  const result = await discard({ git: failing });
  expect(result).toMatchObject({ ok: false, reason: 'git_error' });
});

test('US-005 discard: never fetches or pushes', async () => {
  const real = createGit();
  const calls: string[][] = [];
  const recording: Git = {
    async run(args, options) { calls.push([...args]); return real.run(args, options); },
    async ok(args, options) { calls.push([...args]); return real.ok(args, options); },
  };
  await discard({ git: recording });
  expect(calls.some(([command]) => command === 'fetch' || command === 'push')).toBe(false);
});

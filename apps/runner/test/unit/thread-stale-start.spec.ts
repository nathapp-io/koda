import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGit } from '../../src/executor/git';
import { threadWorktreeDir } from '../../src/thread/thread-paths';
import { prepareThreadWorktree, type ThreadWorktreeResult } from '../../src/thread/thread-worktree';
import { git, isolateGit, makeOrigin, type Origin } from '../helpers/git-fixture';

/**
 * A real clone whose feature branch moves under a worktree that holds an uncommitted edit (US-005 AC-6, AC-7).
 * The fake git in thread-worktree.spec.ts cannot prove what git itself refuses, so these run real git.
 */
let root: string;
let origin: Origin;
let repoDir: string;
let homeDir: string;
const threadId = 't1';
const feature = 'divide';

const prepare = (): Promise<ThreadWorktreeResult> => prepareThreadWorktree({
  git: createGit(),
  mutex: { acquire: async () => () => undefined },
  repoKey: 'owner/repo',
  repoDir,
  cloneUrl: origin.url,
  identity: { owner: 'owner', repo: 'repo' },
  credentialHelper: null,
  homeDir,
  threadId,
  baseRef: 'main',
  feature,
});

beforeEach(async () => {
  isolateGit();
  root = await mkdtemp(join(tmpdir(), 'thread-stale-start-'));
  origin = await makeOrigin(root, 'origin', {
    files: { 'README.md': 'seed\n', 'docs/a.md': 'base\n' },
    branches: [{ name: 'feat/divide', files: { 'docs/a.md': 'divide\n' } }],
  });
  repoDir = join(root, 'repo');
  homeDir = join(root, 'home');
  await git(root, 'clone', '-q', origin.url, repoDir);
});

afterEach(async () => rm(root, { recursive: true, force: true }));

/** The thread's worktree is prepared at main, then the feature branch moves under its uncommitted edit. */
async function movedUnderLocalEdit(): Promise<{ worktree: string; headBefore: string }> {
  const first = await prepare();
  if (!first.ok) throw new Error(`first prepare failed: ${first.reason}`);
  const worktree = threadWorktreeDir(homeDir, threadId);
  await writeFile(join(worktree, 'docs/a.md'), 'local edit\n');
  await git(repoDir, 'branch', `feat/${feature}`, 'origin/feat/divide');
  return { worktree, headBefore: await git(worktree, 'rev-parse', 'HEAD') };
}

test('US-005 stale AC-6: a feature branch that moves under a local edit to the same file is a stale start', async () => {
  await movedUnderLocalEdit();
  const result = await prepare();
  expect(result).toMatchObject({ ok: true, stale: true });
});

test('US-005 stale AC-7: the worktree keeps the uncommitted edit after a stale start', async () => {
  const { worktree } = await movedUnderLocalEdit();
  await prepare();
  expect(await readFile(join(worktree, 'docs/a.md'), 'utf8')).toBe('local edit\n');
});

test('US-005 stale: a stale start stays on the worktree HEAD and reports it as the tip', async () => {
  const { worktree, headBefore } = await movedUnderLocalEdit();
  const result = await prepare();
  expect(result).toEqual({ ok: true, worktree, tipSha: headBefore, stale: true });
  expect(await git(worktree, 'rev-parse', 'HEAD')).toBe(headBefore);
});

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { GitError, type Git, type GitResult } from '../executor/git';
import { prepareThreadWorktree, type PrepareThreadWorktreeInput, type ThreadWorktreeResult } from './thread-worktree';

const root = join(import.meta.dir, `.thread-worktree-git-failure-${crypto.randomUUID()}`);
const homeDir = join(root, 'home');
const repoDir = join(root, 'repo');

/** What `Bun.spawn` throws when the executable is not on `PATH` (or the `cwd` cannot be entered). */
const spawnFailure = (): Error =>
  Object.assign(new Error('Executable not found in $PATH: "git"'), { code: 'ENOENT', errno: -2, path: 'git' });

const gitWithOk = (ok: Git['ok']): Git => ({
  run: async (): Promise<GitResult> => ({ code: 0, stdout: '', stderr: '' }),
  ok,
});

const prepare = (git: Git): Promise<ThreadWorktreeResult> => {
  const input: PrepareThreadWorktreeInput = {
    git,
    mutex: { acquire: async () => () => undefined },
    repoKey: 'owner/repo',
    repoDir,
    cloneUrl: 'https://example.invalid/repo.git',
    identity: { name: 'koda-fleet[bot]', email: 'koda-fleet[bot]@users.noreply.github.com' },
    credentialHelper: null,
    homeDir,
    threadId: 't1',
    baseRef: 'main',
    feature: 'feature-one',
  };
  return prepareThreadWorktree(input);
};

beforeEach(async () => {
  await mkdir(join(repoDir, '.git'), { recursive: true });
  await mkdir(homeDir, { recursive: true });
});

afterEach(() => rm(root, { recursive: true, force: true }));

test('a git that cannot start is a workspace failure, not a missing ref', async () => {
  const result = await prepare(gitWithOk(async () => { throw spawnFailure(); }));
  if (result.ok) throw new Error('a git that never starts must not prepare a worktree');
  expect(result.reason.startsWith('workspace: ')).toBe(true);
  expect(result.reason).not.toBe('checkout: ref not found');
});

test('a refused ref stays the checkout reason', async () => {
  const result = await prepare(gitWithOk(async () => { throw new Error('ref not found'); }));
  expect(result).toEqual({ ok: false, reason: 'checkout: ref not found' });
});

test('a git killed at the timeout is a workspace failure, not a missing ref', async () => {
  const killed: Git['ok'] = async (args) => { throw new GitError(args, { code: 137, stdout: '', stderr: '' }); };
  const result = await prepare(gitWithOk(killed));
  if (result.ok) throw new Error('a git killed at its timeout must not prepare a worktree');
  expect(result.reason.startsWith('workspace: ')).toBe(true);
  expect(result.reason).not.toBe('checkout: ref not found');
});

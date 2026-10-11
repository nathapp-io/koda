import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Git, GitOptions, GitResult } from '../../src/executor/git';
import { threadDirFor, threadWorktreeDir } from '../../src/thread/thread-paths';

const worktreeModule = await import('../../src/thread/thread-worktree').catch(() => undefined);
const root = join(import.meta.dir, `.thread-worktree-${crypto.randomUUID()}`);
const homeDir = join(root, 'home');
const repoDir = join(root, 'repo');
const threadId = 't1';
const feature = 'feature-one';
const baseRef = 'main';
const repoKey = 'owner/repo';

interface FakeGit extends Git {
  calls: { args: readonly string[]; options: GitOptions }[];
  refs: Map<string, string>;
  worktrees: Set<string>;
}

function fakeGit(): FakeGit {
  const git: FakeGit = {
    calls: [],
    refs: new Map([['refs/remotes/origin/main', 'base-sha-1']]),
    worktrees: new Set(),
    async run(args, options): Promise<GitResult> {
      this.calls.push({ args, options });
      if (args[0] === 'fetch') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { code: 0, stdout: [...this.worktrees].map((path) => `worktree ${path}\nHEAD abc\n`).join('\n'), stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        this.worktrees.delete(args.at(-1) ?? '');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        this.worktrees.add(args.at(-2) ?? '');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'checkout') return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    async ok(args, options): Promise<string> {
      this.calls.push({ args, options });
      const joined = args.join(' ');
      if (joined.includes('show-ref') || joined.includes('rev-parse')) {
        const ref = args.at(-1) ?? '';
        const sha = this.refs.get(ref);
        if (sha) return `${sha}\n`;
        throw new Error('ref not found');
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return [...this.worktrees].map((path) => `worktree ${path}\nHEAD abc\n`).join('\n');
      }
      return '';
    },
  };
  return git;
}

const noOpMutex = { acquire: async (_key: string) => () => undefined };

async function setupExistingClone(): Promise<void> {
  await mkdir(join(repoDir, '.git'), { recursive: true });
  await mkdir(homeDir, { recursive: true });
}

async function prepare(git: Git, mutex = noOpMutex) {
  return worktreeModule?.prepareThreadWorktree({
    git,
    mutex,
    repoKey,
    repoDir,
    cloneUrl: 'https://example.invalid/repo.git',
    identity: { owner: 'owner', repo: 'repo' },
    credentialHelper: '/job/git-cred',
    homeDir,
    threadId,
    baseRef,
    feature,
  });
}

beforeEach(async () => {
  await mkdir(root, { recursive: true });
  await setupExistingClone();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('thread worktree preparation (US-005)', () => {
  test('US-005 AC-1: resolves the origin base ref when the feature branch is absent', async () => {
    const git = fakeGit();
    const result = await prepare(git);
    expect(result).toMatchObject({ ok: true, tipSha: 'base-sha-1' });
  });

  test('US-005 AC-2: registers the prepared worktree as locked', async () => {
    const git = fakeGit();
    const result = await prepare(git);
    expect(git.calls.some(({ args }) => args[0] === 'worktree' && args.includes('--lock'))).toBe(true);
    expect(result?.ok).toBe(true);
  });

  test('US-005 AC-3: prepares the worktree in detached HEAD state', async () => {
    const git = fakeGit();
    const result = await prepare(git);
    expect(result?.ok).toBe(true);
    expect(git.calls.some(({ args }) => args[0] === 'checkout' && args.includes('--detach'))).toBe(true);
  });

  test('US-005 AC-4: prefers the local feature branch tip', async () => {
    const git = fakeGit();
    git.refs.set(`refs/heads/feat/${feature}`, 'feature-sha');
    const result = await prepare(git);
    expect(result).toMatchObject({ ok: true, tipSha: 'feature-sha' });
  });

  test('US-005 AC-5: returns a moved origin base tip on refresh', async () => {
    const git = fakeGit();
    await prepare(git);
    git.refs.set('refs/remotes/origin/main', 'base-sha-2');
    const result = await prepare(git);
    expect(result).toMatchObject({ ok: true, tipSha: 'base-sha-2' });
  });

  test('US-005 AC-6: updates the existing worktree to the moved base tip', async () => {
    const git = fakeGit();
    await prepare(git);
    git.refs.set('refs/remotes/origin/main', 'base-sha-2');
    await prepare(git);
    expect(git.calls.some(({ args }) => args[0] === 'checkout' && args.includes('base-sha-2'))).toBe(true);
  });

  test('US-005 AC-7: recreates a registered worktree whose directory was removed', async () => {
    const git = fakeGit();
    const wt = threadWorktreeDir(homeDir, threadId);
    git.worktrees.add(wt);
    await mkdir(threadDirFor(homeDir, threadId), { recursive: true });
    await writeFile(join(threadDirFor(homeDir, threadId), 'thread.json'), JSON.stringify({ repoDir }));
    const result = await prepare(git);
    expect(result?.ok).toBe(true);
  });

  test('US-005 AC-8: reports a missing base ref with the checkout reason', async () => {
    const git = fakeGit();
    git.refs.clear();
    const result = await prepare(git);
    expect(result).toEqual({ ok: false, reason: 'checkout: ref not found' });
  });

  test('US-005 AC-9: refuses a checkout that conflicts with untracked worktree content', async () => {
    const git = fakeGit();
    const wt = threadWorktreeDir(homeDir, threadId);
    git.worktrees.add(wt);
    await mkdir(wt, { recursive: true });
    await writeFile(join(threadDirFor(homeDir, threadId), 'thread.json'), JSON.stringify({ repoDir }));
    git.run = async (args, options) => {
      git.calls.push({ args, options });
      if (args[0] === 'checkout') return { code: 1, stdout: '', stderr: 'untracked working tree files would be overwritten' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const result = await prepare(git);
    expect(result).toMatchObject({ ok: false, reason: 'worktree_conflict' });
  });

  test('US-005 AC-10: does not acquire the repository mutex for an existing clone', async () => {
    let acquired = false;
    const mutex = { acquire: async (_key: string) => { acquired = true; return () => undefined; } };
    const result = await prepare(fakeGit(), mutex);
    expect(result?.ok).toBe(true);
    expect(acquired).toBe(false);
  });

  test('US-005 AC-11: acquires the repository mutex using the repo key for a missing clone', async () => {
    await rm(repoDir, { recursive: true, force: true });
    const keys: string[] = [];
    const mutex = { acquire: async (key: string) => { keys.push(key); return () => undefined; } };
    const git = fakeGit();
    git.run = async (args, options) => {
      git.calls.push({ args, options });
      if (args[0] === 'clone') await mkdir(join(repoDir, '.git'), { recursive: true });
      return { code: 0, stdout: '', stderr: '' };
    };
    await prepare(git, mutex);
    expect(keys).toEqual([repoKey]);
  });

  test('US-005 AC-12: does not persist the job credential helper in an existing clone', async () => {
    const git = fakeGit();
    const result = await prepare(git);
    expect(result?.ok).toBe(true);
    expect(git.calls.some(({ args }) => args.includes('config') && args.includes('credential.helper'))).toBe(false);
  });
});

describe('archived thread pruning (US-005)', () => {
  test('US-005 AC-13: deletes the archived thread registration directory', async () => {
    const git = fakeGit();
    await mkdir(threadDirFor(homeDir, threadId), { recursive: true });
    await writeFile(join(threadDirFor(homeDir, threadId), 'thread.json'), JSON.stringify({ repoDir }));
    await worktreeModule?.pruneArchivedThreads({ git, homeDir, threadIds: [threadId], activeThreadIds: [] });
    await expect(readFile(join(threadDirFor(homeDir, threadId), 'thread.json'), 'utf8')).rejects.toThrow();
  });

  test('US-005 AC-14: removes the archived thread worktree registration from git', async () => {
    const git = fakeGit();
    const wt = threadWorktreeDir(homeDir, threadId);
    git.worktrees.add(wt);
    await mkdir(threadDirFor(homeDir, threadId), { recursive: true });
    await writeFile(join(threadDirFor(homeDir, threadId), 'thread.json'), JSON.stringify({ repoDir }));
    await worktreeModule?.pruneArchivedThreads({ git, homeDir, threadIds: [threadId], activeThreadIds: [] });
    expect(git.worktrees.has(wt)).toBe(false);
  });

  test('US-005 AC-15: keeps an active thread directory', async () => {
    expect(worktreeModule).toBeDefined();
    const git = fakeGit();
    await mkdir(threadDirFor(homeDir, threadId), { recursive: true });
    await writeFile(join(threadDirFor(homeDir, threadId), 'thread.json'), JSON.stringify({ repoDir }));
    await worktreeModule?.pruneArchivedThreads({ git, homeDir, threadIds: [threadId], activeThreadIds: [threadId] });
    await expect(readFile(join(threadDirFor(homeDir, threadId), 'thread.json'), 'utf8')).resolves.toContain(repoDir);
  });
});

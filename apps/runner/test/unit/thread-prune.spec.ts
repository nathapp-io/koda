import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Git, GitOptions, GitResult } from '../../src/executor/git';
import { threadDirFor, threadWorktreeDir } from '../../src/thread/thread-paths';
import { pruneThreads } from '../../src/thread/thread-prune';
import { pruneArchivedThreads } from '../../src/thread/thread-worktree';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

interface FakeGit {
  git: Git;
  calls: string[][];
  worktrees: Set<string>;
  /** What `worktree remove` answers: 0 withdraws the registration, anything else is git's refusal. */
  removeCode: number;
  /** A git that cannot run at all: `worktree list` rejects the way a missing binary or a timeout does. */
  listThrows: boolean;
}

/** A clone that lists the registrations a test planted and removes them on a zero verdict. */
function fakeGit(): FakeGit {
  const fake: FakeGit = {
    git: { run: async () => ({ code: 0, stdout: '', stderr: '' }), ok: async () => '' },
    calls: [], worktrees: new Set(), removeCode: 0, listThrows: false,
  };
  const run = async (args: readonly string[], _options: GitOptions): Promise<GitResult> => {
    fake.calls.push([...args]);
    if (args[0] === 'worktree' && args[1] === 'list') {
      if (fake.listThrows) throw new Error('spawn git ENOENT');
      return { code: 0, stdout: [...fake.worktrees].map((path) => `worktree ${path}\nHEAD abc\n`).join('\n'), stderr: '' };
    }
    if (args[0] === 'worktree' && args[1] === 'remove') {
      if (fake.removeCode !== 0) return { code: fake.removeCode, stdout: '', stderr: 'fatal: cannot remove' };
      fake.worktrees.delete(args.at(-1) ?? '');
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  fake.git = { run, ok: async (args, options) => (await run(args, options)).stdout };
  return fake;
}

/** A fixture home, a clone the thread metadata can name, and a seed for one archived thread directory. */
async function fixture() {
  const base = await tmp.make('prune');
  const homeDir = join(base, 'home');
  const repoDir = join(base, 'repo');
  await mkdir(join(repoDir, '.git'), { recursive: true });
  /** `meta` writes the `thread.json` that names the clone to withdraw a worktree registration from. */
  const seed = async (threadId: string, meta: boolean) => {
    const dir = threadDirFor(homeDir, threadId);
    await mkdir(dir, { recursive: true });
    if (meta) await writeFile(join(dir, 'thread.json'), JSON.stringify({ repoDir }));
    return { dir, worktree: threadWorktreeDir(homeDir, threadId) };
  };
  return { homeDir, seed };
}

const removes = (fake: FakeGit): string[][] => fake.calls.filter((args) => args[0] === 'worktree' && args[1] === 'remove');

describe('archived thread prune resilience (US-007)', () => {
  test('a refusal keeps the thread for the next pass and does not skip the ids after it', async () => {
    const f = await fixture();
    const one = await f.seed('t1', true);
    const two = await f.seed('t2', true);
    const fake = fakeGit();
    fake.worktrees.add(one.worktree);
    fake.worktrees.add(two.worktree);
    fake.removeCode = 128;

    await expect(pruneArchivedThreads({ git: fake.git, homeDir: f.homeDir, threadIds: ['t1', 't2'], activeThreadIds: [] }))
      .rejects.toThrow(/git worktree failed/);

    expect(removes(fake)).toHaveLength(2);   // t2 was attempted even though t1 failed
    expect(existsSync(one.dir)).toBe(true);  // git still claims the registration: the directory stays
    expect(existsSync(two.dir)).toBe(true);
  });

  test('a git that cannot run keeps the thread and still prunes the ids after it', async () => {
    const f = await fixture();
    const one = await f.seed('t1', true);
    const two = await f.seed('t2', false);
    const fake = fakeGit();
    fake.listThrows = true;

    await expect(pruneArchivedThreads({ git: fake.git, homeDir: f.homeDir, threadIds: ['t1', 't2'], activeThreadIds: [] }))
      .rejects.toThrow(/spawn git ENOENT/);

    expect(existsSync(one.dir)).toBe(true);
    expect(existsSync(two.dir)).toBe(false);
  });

  test('an unregistered thread loses its directory without a git removal', async () => {
    const f = await fixture();
    const one = await f.seed('t1', true);
    const fake = fakeGit();

    await pruneArchivedThreads({ git: fake.git, homeDir: f.homeDir, threadIds: ['t1'], activeThreadIds: [] });

    expect(removes(fake)).toEqual([]);
    expect(existsSync(one.dir)).toBe(false);
  });

  test('a registered worktree is withdrawn before its directory goes', async () => {
    const f = await fixture();
    const one = await f.seed('t1', true);
    const fake = fakeGit();
    fake.worktrees.add(one.worktree);

    await pruneArchivedThreads({ git: fake.git, homeDir: f.homeDir, threadIds: ['t1'], activeThreadIds: [] });

    expect(fake.worktrees.has(one.worktree)).toBe(false);
    expect(existsSync(one.dir)).toBe(false);
  });
});

describe('thread prune pass isolation (US-007)', () => {
  test('an unprunable thread does not starve the skill cache, and the pass still reports the failure', async () => {
    const f = await fixture();
    const one = await f.seed('t9', true);
    const snapshot = join(f.homeDir, 'skills', 's1', 'a'.repeat(40));
    await mkdir(snapshot, { recursive: true });
    const old = new Date(Date.now() - 31 * 86_400_000);
    await utimes(snapshot, old, old);
    const fake = fakeGit();
    fake.listThrows = true;

    await expect(pruneThreads({ git: fake.git, homeDir: f.homeDir, archivedThreadIds: ['t9'], activeThreadIds: [], now: () => new Date() }))
      .rejects.toThrow(/spawn git ENOENT/);

    expect(existsSync(one.dir)).toBe(true);
    expect(existsSync(snapshot)).toBe(false);
  });

  test('a clean pass removes the archived thread and the stale skill snapshot', async () => {
    const f = await fixture();
    const one = await f.seed('t9', false);
    const snapshot = join(f.homeDir, 'skills', 's1', 'a'.repeat(40));
    await mkdir(snapshot, { recursive: true });
    const old = new Date(Date.now() - 31 * 86_400_000);
    await utimes(snapshot, old, old);

    await pruneThreads({ homeDir: f.homeDir, archivedThreadIds: ['t9'], activeThreadIds: [], now: () => new Date() });

    expect(existsSync(one.dir)).toBe(false);
    expect(existsSync(snapshot)).toBe(false);
  });
});

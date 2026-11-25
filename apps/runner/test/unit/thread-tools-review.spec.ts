import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGit, type Git, type GitOptions, type GitResult } from '../../src/executor/git';
import { listFilesTool } from '../../src/thread/tools/list-files';
import { searchRepoTool } from '../../src/thread/tools/search-repo';
import type { ThreadToolContext } from '../../src/thread/tools/types';
import { git as sh, isolateGit } from '../helpers/git-fixture';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
beforeAll(() => isolateGit());
afterAll(() => tmp.cleanup());

function contextWith(run: Git['run'], options: { searchTimeoutMs?: number } = {}): ThreadToolContext {
  const git: Git = {
    run,
    async ok(): Promise<string> {
      return '';
    },
  };
  return {
    worktree: '/worktree',
    skillsRoot: '/skills',
    skills: [],
    git,
    searchTimeoutMs: options.searchTimeoutMs ?? 1_000,
    nowMs: () => 0,
  };
}

describe('thread tools: git failures and bounds (review)', () => {
  test('a git spawn failure becomes an isError result for list_files', async () => {
    const ctx = contextWith(async () => {
      throw new Error('spawn git ENOENT');
    });
    const result = await listFilesTool(ctx).run({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('spawn git ENOENT');
  });

  test('a git spawn failure becomes an isError result for search_repo', async () => {
    const ctx = contextWith(async () => {
      throw new Error('spawn git ENOENT');
    });
    const result = await searchRepoTool(ctx).run({ pattern: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('spawn git ENOENT');
  });

  test('a giant tracked hit truncates search before untracked discovery', async () => {
    const worktree = await tmp.make('search-giant-hit');
    await sh(worktree, 'init', '-q');
    await writeFile(join(worktree, 'big.txt'), `needle ${'界'.repeat(80_000)}\n`);
    await sh(worktree, 'add', '--', 'big.txt');
    const realGit = createGit();
    const ctx = contextWith((args, options) => {
      if (args.includes('ls-files')) throw new Error('untracked discovery ran after truncation');
      return realGit.run(args, options);
    });
    ctx.worktree = worktree;
    expect(await searchRepoTool(ctx).run({ pattern: 'needle' })).toEqual({ content: '[truncated]' });
  });

  test('search retains untracked matches past the first pathspec batch', async () => {
    const worktree = await tmp.make('search-untracked-batches');
    await sh(worktree, 'init', '-q');
    await mkdir(join(worktree, 'docs'));
    const paths = Array.from({ length: 130 }, (_, index) => `docs/${String(index).padStart(3, '0')}-${'x'.repeat(200)}.md`);
    await Promise.all(paths.map((path, index) => writeFile(join(worktree, path),
      index === 0 || index === paths.length - 1 ? 'needle\n' : 'ignore\n')));
    const ctx = contextWith(createGit().run, { searchTimeoutMs: 20_000 });
    ctx.worktree = worktree;
    expect(await searchRepoTool(ctx).run({ pattern: 'needle' }))
      .toEqual({ content: `${paths[0]}:1:needle\n${paths.at(-1)}:1:needle` });
    expect(await searchRepoTool(ctx).run({ pattern: 'needle', max: 1 }))
      .toEqual({ content: `${paths[0]}:1:needle\n[truncated]` });
  });

  test('list_files passes the search timeout to git for both the tracked and the untracked ls-files calls', async () => {
    const seen: GitOptions[] = [];
    const ctx = contextWith(async (_args, options): Promise<GitResult> => {
      seen.push(options);
      return { code: 0, stdout: '', stderr: '' };
    }, { searchTimeoutMs: 4_321 });
    await listFilesTool(ctx).run({});
    expect(seen.map((options) => options.timeoutMs)).toEqual([4_321, 4_321]);
  });
});

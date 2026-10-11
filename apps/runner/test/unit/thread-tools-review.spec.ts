import { describe, expect, test } from 'bun:test';
import type { Git, GitOptions, GitResult } from '../../src/executor/git';
import { listFilesTool } from '../../src/thread/tools/list-files';
import { searchRepoTool } from '../../src/thread/tools/search-repo';
import type { ThreadToolContext } from '../../src/thread/tools/types';

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

  test('list_files passes the search timeout to git so a slow ls-files cannot stall past it', async () => {
    const seen: GitOptions[] = [];
    const ctx = contextWith(async (_args, options): Promise<GitResult> => {
      seen.push(options);
      return { code: 0, stdout: '', stderr: '' };
    }, { searchTimeoutMs: 4_321 });
    await listFilesTool(ctx).run({});
    expect(seen.map((options) => options.timeoutMs)).toEqual([4_321]);
  });
});

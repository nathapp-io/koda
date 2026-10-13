import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { isAllowedThreadDocPath } from '@nathapp/fleet-protocol';
import { firstLine } from '../../errors';
import { refused } from './shared';
import type { ThreadToolContext, ThreadToolResult } from './types';

/** One pathspec for the optional dir and glob; `dir` alone lists everything under it. */
export function pathspecFor(dir: string | undefined, glob: string | undefined): string | undefined {
  if (dir === undefined && glob === undefined) return undefined;
  if (dir === undefined) return `:(glob)${glob}`;
  return `:(glob)${dir}/${glob ?? '**'}`;
}

/**
 * The untracked, non-ignored files under `pathspec` (undefined: the whole worktree) that a thread may write
 * (`isAllowedThreadDocPath`) and are regular files, in git's order. Every other untracked file, every symlink and every
 * ignored file stays out of list_files and search_repo.
 */
export async function allowedUntrackedPaths(ctx: ThreadToolContext, pathspec: string | undefined): Promise<string[] | ThreadToolResult> {
  const args = pathspec === undefined
    ? ['ls-files', '-z', '--others', '--exclude-standard']
    : ['ls-files', '-z', '--others', '--exclude-standard', '--', pathspec];
  const result = await ctx.git.run(args, { cwd: ctx.worktree, timeoutMs: ctx.searchTimeoutMs });
  if (result.code !== 0) return refused(firstLine(result.stderr) || `git ls-files exited ${result.code}`);
  const feature = ctx.feature ?? '';
  const candidates = result.stdout.split('\0').filter((path) => path.length > 0 && isAllowedThreadDocPath(path, feature));
  // A symlink is never a thread doc: git grep --no-index would read the file it points at, outside the worktree.
  const regular: string[] = [];
  for (const path of candidates) {
    const info = await lstat(join(ctx.worktree, path)).catch(() => null);
    if (info?.isFile()) regular.push(path);
  }
  return regular;
}

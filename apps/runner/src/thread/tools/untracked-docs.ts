import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { isAllowedThreadDocPath } from '@nathapp/fleet-protocol';
import { runGitRecords } from '../../executor/git-records';
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
export async function visitAllowedUntrackedPaths(
  ctx: ThreadToolContext, pathspec: string | undefined, visit: (path: string) => boolean | Promise<boolean>,
): Promise<ThreadToolResult | undefined> {
  const args = pathspec === undefined
    ? ['ls-files', '-z', '--others', '--exclude-standard']
    : ['ls-files', '-z', '--others', '--exclude-standard', '--', pathspec];
  const feature = ctx.feature ?? '';
  const result = await runGitRecords(ctx.git, args, { cwd: ctx.worktree, timeoutMs: ctx.searchTimeoutMs }, {
    delimiter: '\0',
    maxRecordBytes: 65_536,
    onRecord(path) {
      if (!path || !isAllowedThreadDocPath(path, feature)) return true;
      // A symlink is never a thread doc: git grep --no-index would follow it outside the worktree.
      return lstat(join(ctx.worktree, path)).catch(() => null).then((info) => info?.isFile() ? visit(path) : true);
    },
  });
  if (result.code !== 0) return refused(firstLine(result.stderr) || `git ls-files exited ${result.code}`);
  return undefined;
}

import { firstLine } from '../../errors';
import { assertRelativePath } from '../../paths/safe-segment';
import { checkGlob, fieldOf, joinCapped, refused, refuseInvalidInput } from './shared';
import type { ThreadTool, ThreadToolContext, ThreadToolResult } from './types';

const MAX_ENTRIES = 2_000;
const MAX_BYTES = 262_144;

/** One pathspec for the optional dir and glob; `dir` alone lists everything under it. */
function pathspecFor(dir: string | undefined, glob: string | undefined): string | undefined {
  if (dir === undefined && glob === undefined) return undefined;
  if (dir === undefined) return `:(glob)${glob}`;
  return `:(glob)${dir}/${glob ?? '**'}`;
}

async function list(ctx: ThreadToolContext, input: unknown): Promise<ThreadToolResult> {
  const rawDir = fieldOf(input, 'dir');
  const dir = rawDir === undefined ? undefined : assertRelativePath('dir', rawDir);
  const rawGlob = fieldOf(input, 'glob');
  const glob = rawGlob === undefined ? undefined : checkGlob(rawGlob);
  const pathspec = pathspecFor(dir, glob);
  const args = pathspec === undefined ? ['ls-files', '-z'] : ['ls-files', '-z', '--', pathspec];
  const result = await ctx.git.run(args, { cwd: ctx.worktree });
  if (result.code !== 0) return refused(firstLine(result.stderr) || `git ls-files exited ${result.code}`);

  const entries = result.stdout.split('\0').filter((entry) => entry.length > 0);
  const lines = entries.slice(0, MAX_ENTRIES);
  if (entries.length > MAX_ENTRIES) lines.push(`[truncated: ${entries.length - MAX_ENTRIES} more]`);
  return { content: joinCapped(lines, MAX_BYTES, false) };
}

/** Lists tracked files only; ignored and untracked files never appear. */
export function listFilesTool(ctx: ThreadToolContext): ThreadTool {
  return {
    name: 'list_files',
    approval: 'never',
    run: (input) => refuseInvalidInput(() => list(ctx, input)),
  };
}

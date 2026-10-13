import { firstLine } from '../../errors';
import { assertRelativePath } from '../../paths/safe-segment';
import { allowedUntrackedPaths, pathspecFor } from './untracked-docs';
import { checkGlob, fieldOf, joinCapped, refused, refuseInvalidInput } from './shared';
import type { ThreadTool, ThreadToolContext, ThreadToolResult } from './types';

const MAX_ENTRIES = 2_000;
const MAX_BYTES = 262_144;

async function list(ctx: ThreadToolContext, input: unknown): Promise<ThreadToolResult> {
  const rawDir = fieldOf(input, 'dir');
  const dir = rawDir === undefined ? undefined : assertRelativePath('dir', rawDir);
  const rawGlob = fieldOf(input, 'glob');
  const glob = rawGlob === undefined ? undefined : checkGlob(rawGlob);
  const pathspec = pathspecFor(dir, glob);
  const args = pathspec === undefined ? ['ls-files', '-z'] : ['ls-files', '-z', '--', pathspec];
  const result = await ctx.git.run(args, { cwd: ctx.worktree, timeoutMs: ctx.searchTimeoutMs });
  if (result.code !== 0) return refused(firstLine(result.stderr) || `git ls-files exited ${result.code}`);

  const tracked = result.stdout.split('\0').filter((entry) => entry.length > 0);
  const untracked = await allowedUntrackedPaths(ctx, pathspec);
  if (!Array.isArray(untracked)) return untracked;
  const entries = [...new Set([...tracked, ...untracked])];
  const lines = entries.slice(0, MAX_ENTRIES);
  if (entries.length > MAX_ENTRIES) lines.push(`[truncated: ${entries.length - MAX_ENTRIES} more]`);
  return { content: joinCapped(lines, MAX_BYTES, false) };
}

/**
 * Lists tracked files, plus untracked files a thread may write (docs/** and its feature's .nax/features/ .md files).
 * Other untracked files and ignored files never appear.
 */
export function listFilesTool(ctx: ThreadToolContext): ThreadTool {
  return {
    name: 'list_files',
    description: 'List tracked files in the repository, plus untracked thread doc files under docs/ or the thread feature\'s .nax/features/ directory, optionally under a directory or matching a glob. Other untracked files and ignored files are not listed.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Repository-relative directory to list under.' },
        glob: { type: 'string', description: 'Glob pattern for file paths, for example **/*.md.' },
      },
      additionalProperties: false,
    },
    approval: 'never',
    run: (input) => refuseInvalidInput(() => list(ctx, input)),
  };
}

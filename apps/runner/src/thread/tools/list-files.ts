import { runGitRecords } from '../../executor/git-records';
import { firstLine } from '../../errors';
import { assertRelativePath } from '../../paths/safe-segment';
import { pathspecFor, visitAllowedUntrackedPaths } from './untracked-docs';
import { checkGlob, fieldOf, FileListing, refused, refuseInvalidInput } from './shared';
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
  const listing = new FileListing(MAX_ENTRIES, MAX_BYTES);
  let previous: string | null = null;
  const result = await runGitRecords(ctx.git, args, { cwd: ctx.worktree, timeoutMs: ctx.searchTimeoutMs }, {
    delimiter: '\0',
    maxRecordBytes: MAX_BYTES,
    onRecord(path) {
      // Git lists index stages for the same path consecutively.
      if (path === null || (path.length > 0 && path !== previous)) listing.add(path);
      previous = path;
      return true;
    },
  });
  if (result.code !== 0) return refused(firstLine(result.stderr) || `git ls-files exited ${result.code}`);

  // ls-files --others excludes all tracked entries, so it cannot repeat a path from the index.
  const failure = await visitAllowedUntrackedPaths(ctx, pathspec, (path) => {
    listing.add(path);
    return true;
  });
  return failure ?? { content: listing.content() };
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

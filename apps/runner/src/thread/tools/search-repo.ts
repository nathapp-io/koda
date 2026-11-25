import { CappedLines, checkGlob, fieldOf, refuseInvalidInput } from './shared';
import { checkFixed, checkMax, checkPattern, collectGrep, SEARCH_MAX_BYTES } from './grep-output';
import { pathspecFor, visitAllowedUntrackedPaths } from './untracked-docs';
import type { ThreadTool, ThreadToolContext, ThreadToolResult } from './types';

// Budget the argv of each untracked grep, including one NUL per pathspec.
const UNTRACKED_GREP_ARG_BYTES = 24 * 1024;

/** `git grep` flags shared by the tracked and the untracked search. `noIndex` searches files on disk, not the index. */
function grepFlags(pattern: string, fixed: boolean, noIndex: boolean): string[] {
  return ['-c', 'core.quotePath=false', 'grep', '-n', '-I', '--no-color', ...(noIndex ? ['--no-index'] : []), fixed ? '-F' : '-E', '-e', pattern];
}

async function search(ctx: ThreadToolContext, input: unknown): Promise<ThreadToolResult> {
  const pattern = checkPattern(fieldOf(input, 'pattern'));
  const rawGlob = fieldOf(input, 'glob');
  const glob = rawGlob === undefined ? undefined : checkGlob(rawGlob);
  const max = checkMax(fieldOf(input, 'max'));
  const fixed = checkFixed(fieldOf(input, 'fixed'));

  const startedAt = ctx.nowMs();
  const hits = new CappedLines(SEARCH_MAX_BYTES, max);
  const grep = (args: readonly string[]) => collectGrep(ctx.git, args, {
    cwd: ctx.worktree,
    env: { GIT_CONFIG_NOSYSTEM: '1' },
    timeoutMs: ctx.searchTimeoutMs,
  }, () => ctx.nowMs() - startedAt >= ctx.searchTimeoutMs, hits);

  const trackedArgs = grepFlags(pattern, fixed, false);
  if (glob !== undefined) trackedArgs.push('--', `:(glob)${glob}`);
  const trackedFailure = await grep(trackedArgs);
  if (trackedFailure !== undefined) return trackedFailure;
  if (hits.cut) return { content: hits.content() };

  // Both ls-files --others and grep --no-index visit paths in Git's order. Keep only one batch of
  // literal pathspecs while preserving the tracked-first order and the untracked doc allowlist.
  let batch: string[] = [];
  let bytes = 0;
  let failed: ThreadToolResult | undefined;
  const grepBatch = async (): Promise<boolean> => {
    failed = await grep([...grepFlags(pattern, fixed, true), '--', ...batch]);
    batch = [];
    bytes = 0;
    return failed === undefined && !hits.cut;
  };
  const listingFailure = await visitAllowedUntrackedPaths(ctx, pathspecFor(undefined, glob), async (path) => {
    const literal = `:(literal)${path}`;
    const size = Buffer.byteLength(literal) + 1;
    if (batch.length > 0 && bytes + size > UNTRACKED_GREP_ARG_BYTES && !(await grepBatch())) return false;
    batch.push(literal);
    bytes += size;
    return true;
  });
  if (listingFailure !== undefined) return listingFailure;
  if (batch.length > 0) await grepBatch();
  if (failed !== undefined) return failed;
  return { content: hits.lines.length === 0 && !hits.cut ? 'no matches' : hits.content() };
}

/** Searches tracked files, plus untracked thread doc files (docs/** and the feature's .nax/features/ .md files). Ignored files and other untracked files never match. */
export function searchRepoTool(ctx: ThreadToolContext): ThreadTool {
  return {
    name: 'search_repo',
    description: 'Search tracked text files in the repository, plus untracked thread doc files under docs/ or the thread feature\'s .nax/features/ directory, for a pattern. Returns path:line:text hits. Other untracked files and ignored files are not searched.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Pattern to search for (extended regex unless fixed is true).' },
        glob: { type: 'string', description: 'Restrict the search to paths matching this glob.' },
        max: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum hit lines to return; default 200.' },
        fixed: { type: 'boolean', description: 'Treat pattern as a fixed string.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    approval: 'never',
    run: (input) => refuseInvalidInput(() => search(ctx, input)),
  };
}

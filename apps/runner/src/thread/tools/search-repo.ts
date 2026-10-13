import { firstLine } from '../../errors';
import { checkGlob, fieldOf, InvalidToolInput, joinCapped, refused, refuseInvalidInput } from './shared';
import { allowedUntrackedPaths, pathspecFor } from './untracked-docs';
import type { ThreadTool, ThreadToolContext, ThreadToolResult } from './types';

const MAX_PATTERN_CHARS = 1_000;
const DEFAULT_MAX_HITS = 200;
const MAX_HITS_LIMIT = 200;
const MAX_BYTES = 65_536;

function checkPattern(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_PATTERN_CHARS) throw new InvalidToolInput('invalid pattern');
  return value;
}

function checkMax(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_HITS;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_HITS_LIMIT) throw new InvalidToolInput('invalid max');
  return value;
}

function checkFixed(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new InvalidToolInput('invalid fixed');
  return value;
}

/** One `git grep`: its hit lines (none on exit 1, no match), or the refusal to return to the agent. */
type GrepOutcome = { hits: string[] } | { failed: ThreadToolResult };

/** `git grep` flags shared by the tracked and the untracked search. `noIndex` searches files on disk, not the index. */
function grepFlags(pattern: string, fixed: boolean, noIndex: boolean): string[] {
  return ['-c', 'core.quotePath=false', 'grep', '-n', '-I', '--no-color', ...(noIndex ? ['--no-index'] : []), fixed ? '-F' : '-E', '-e', pattern];
}

async function grep(ctx: ThreadToolContext, args: readonly string[], startedAt: number): Promise<GrepOutcome> {
  const result = await ctx.git.run(args, {
    cwd: ctx.worktree,
    env: { GIT_CONFIG_NOSYSTEM: '1' },
    timeoutMs: ctx.searchTimeoutMs,
  });
  if (result.code === 0) return { hits: result.stdout.split('\n').filter((line) => line.length > 0) };
  if (result.code === 1) return { hits: [] };
  if (ctx.nowMs() - startedAt >= ctx.searchTimeoutMs) return { failed: refused('search timed out') };
  return { failed: refused(firstLine(result.stderr) || `git grep exited ${result.code}`) };
}

async function search(ctx: ThreadToolContext, input: unknown): Promise<ThreadToolResult> {
  const pattern = checkPattern(fieldOf(input, 'pattern'));
  const rawGlob = fieldOf(input, 'glob');
  const glob = rawGlob === undefined ? undefined : checkGlob(rawGlob);
  const max = checkMax(fieldOf(input, 'max'));
  const fixed = checkFixed(fieldOf(input, 'fixed'));

  const startedAt = ctx.nowMs();
  const trackedArgs = grepFlags(pattern, fixed, false);
  if (glob !== undefined) trackedArgs.push('--', `:(glob)${glob}`);
  const tracked = await grep(ctx, trackedArgs, startedAt);
  if ('failed' in tracked) return tracked.failed;

  const untracked = await allowedUntrackedPaths(ctx, pathspecFor(undefined, glob));
  if (!Array.isArray(untracked)) return untracked;
  let hits: string[] = tracked.hits;
  if (untracked.length > 0) {
    // The paths are literal file names from the allowlist, so each one is matched as a literal pathspec.
    const untrackedArgs = [...grepFlags(pattern, fixed, true), '--', ...untracked.map((path) => `:(literal)${path}`)];
    const extra = await grep(ctx, untrackedArgs, startedAt);
    if ('failed' in extra) return extra.failed;
    hits = [...hits, ...extra.hits];
  }
  const unique = [...new Set(hits)];
  if (unique.length === 0) return { content: 'no matches' };
  return { content: joinCapped(unique.slice(0, max), MAX_BYTES, unique.length > max) };
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

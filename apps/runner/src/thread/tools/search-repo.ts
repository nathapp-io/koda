import { firstLine } from '../../errors';
import { checkGlob, fieldOf, InvalidToolInput, joinCapped, refused, refuseInvalidInput } from './shared';
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

async function search(ctx: ThreadToolContext, input: unknown): Promise<ThreadToolResult> {
  const pattern = checkPattern(fieldOf(input, 'pattern'));
  const rawGlob = fieldOf(input, 'glob');
  const glob = rawGlob === undefined ? undefined : checkGlob(rawGlob);
  const max = checkMax(fieldOf(input, 'max'));
  const fixed = checkFixed(fieldOf(input, 'fixed'));

  const args = ['-c', 'core.quotePath=false', 'grep', '-n', '-I', '--no-color', fixed ? '-F' : '-E', '-e', pattern];
  if (glob !== undefined) args.push('--', `:(glob)${glob}`);

  const startedAt = ctx.nowMs();
  const result = await ctx.git.run(args, {
    cwd: ctx.worktree,
    env: { GIT_CONFIG_NOSYSTEM: '1' },
    timeoutMs: ctx.searchTimeoutMs,
  });
  if (result.code === 0) {
    const hits = result.stdout.split('\n').filter((line) => line.length > 0);
    return { content: joinCapped(hits.slice(0, max), MAX_BYTES, hits.length > max) };
  }
  if (result.code === 1) return { content: 'no matches' };
  if (ctx.nowMs() - startedAt >= ctx.searchTimeoutMs) return refused('search timed out');
  return refused(firstLine(result.stderr) || `git grep exited ${result.code}`);
}

/** Searches tracked files only; git grep skips untracked and binary files. */
export function searchRepoTool(ctx: ThreadToolContext): ThreadTool {
  return {
    name: 'search_repo',
    approval: 'never',
    run: (input) => refuseInvalidInput(() => search(ctx, input)),
  };
}

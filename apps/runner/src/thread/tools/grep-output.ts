import { firstLine } from '../../errors';
import type { Git, GitOptions } from '../../executor/git';
import { runGitRecords } from '../../executor/git-records';
import { CappedLines, InvalidToolInput, refused } from './shared';
import type { ThreadToolResult } from './types';

export const SEARCH_MAX_BYTES = 65_536;
// Git's parallel grep workers buffer matching files before writing stdout. A single worker
// streams hits immediately, so the runner can stop Git as soon as the result fills.
export const GREP_ARGS = ['-c', 'core.quotePath=false', 'grep', '--threads=1', '-n', '-I', '--no-color'] as const;
const MAX_PATTERN_CHARS = 1_000;
const DEFAULT_MAX_HITS = 200;
const MAX_HITS_LIMIT = 200;

export function checkPattern(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_PATTERN_CHARS) throw new InvalidToolInput('invalid pattern');
  return value;
}

export function checkMax(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_HITS;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_HITS_LIMIT) throw new InvalidToolInput('invalid max');
  return value;
}

export function checkFixed(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new InvalidToolInput('invalid fixed');
  return value;
}

/** Read until an additional hit establishes truncation, even when the previous hit filled the entry limit exactly. */
export async function collectGrep(
  git: Git, args: readonly string[], options: GitOptions, isTimedOut: () => boolean,
  hits: CappedLines, prefix?: { readonly from: string; readonly to: string },
): Promise<ThreadToolResult | undefined> {
  const result = await runGitRecords(git, args, options, {
    delimiter: '\n',
    maxRecordBytes: SEARCH_MAX_BYTES + (prefix?.from.length ?? 0),
    onRecord(line) {
      if (line === '') return true;
      if (line === null) return hits.add(null);
      const hit = prefix === undefined ? line : `${prefix.to}${line.slice(line.indexOf(':') + 1)}`;
      // The worktree search combined tracked and untracked hits with first-seen de-duplication.
      return (prefix === undefined && hits.lines.includes(hit)) || hits.add(hit);
    },
  });
  if (result.timedOut) return refused('search timed out');
  if (result.code === 0 || result.code === 1) return undefined;
  if (isTimedOut()) return refused('search timed out');
  return refused(firstLine(result.stderr) || `git grep exited ${result.code}`);
}

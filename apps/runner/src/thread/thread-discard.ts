import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ThreadDiscardFailReason } from '@nathapp/fleet-protocol';
import { sanitizeDiagnostic } from '../diagnostics';
import type { Git } from '../executor/git';
import { assertFeature } from '../paths/safe-segment';
import { threadWorktreeDir } from './thread-paths';
import { resolveTip } from './thread-worktree';

const DISCARD_GIT_TIMEOUT_MS = 60_000;

export interface DiscardThreadChangesInput {
  readonly git: Git;
  readonly homeDir: string;
  readonly repoDir: string;
  readonly threadId: string;
  readonly feature: string;
  readonly baseRef: string;
}

export type DiscardThreadChangesResult =
  | { ok: true; tipSha: string }
  | { ok: false; reason: ThreadDiscardFailReason; detail?: string };

const detailOf = (error: unknown): string => sanitizeDiagnostic(error instanceof Error ? error.message : String(error));

/** Publish step 1: the directory must be a worktree of its own, not a folder inside another work tree. */
async function isOwnWorktree(git: Git, worktree: string): Promise<boolean> {
  try {
    await lstat(join(worktree, '.git'));
    const [topLevel, worktreeReal] = await Promise.all([
      git.ok(['rev-parse', '--show-toplevel'], { cwd: worktree, timeoutMs: DISCARD_GIT_TIMEOUT_MS }),
      realpath(worktree),
    ]);
    return resolve(topLevel.trim()) === worktreeReal;
  } catch {
    return false;
  }
}

/**
 * Discard one thread's unpublished work: reset and clean its own worktree, then re-detach it at the feature
 * branch tip (or `origin/<baseRef>` when the branch does not exist). Ignored files survive, because `git clean`
 * runs without `-x`. Nothing is fetched and no repository mutex is taken: only the thread's worktree changes.
 */
export async function discardThreadChanges(input: DiscardThreadChangesInput): Promise<DiscardThreadChangesResult> {
  const feature = assertFeature(input.feature);
  const worktree = threadWorktreeDir(input.homeDir, input.threadId);
  const { git } = input;
  if (!(await isOwnWorktree(git, worktree))) return { ok: false, reason: 'no_worktree' };

  const options = { cwd: worktree, timeoutMs: DISCARD_GIT_TIMEOUT_MS } as const;
  try {
    await git.ok(['reset', '--hard', 'HEAD'], options);
    await git.ok(['clean', '-fd'], options);
    const tip = await resolveTip(git, input.repoDir, feature, input.baseRef);
    if (!tip.ok) return { ok: false, reason: 'git_error', detail: tip.reason };
    await git.ok(['checkout', '--detach', tip.sha], options);
    return { ok: true, tipSha: tip.sha };
  } catch (error) {
    return { ok: false, reason: 'git_error', detail: detailOf(error) };
  }
}

import { join } from 'node:path';
import type { Git } from '../executor/git';
import { systemNow, type Now } from '../time';
import { pruneSkillCache } from './skill-fetch';
import { pruneArchivedThreads } from './thread-worktree';

export interface PruneThreadsInput {
  readonly homeDir: string;
  /** The thread ids the server has archived; the latest sync response's list. */
  readonly archivedThreadIds: readonly string[];
  /** `thread.threadId` of every active THREAD row: an archived thread that is still running keeps its assets. */
  readonly activeThreadIds: readonly string[];
  /** The clone to withdraw a pruned thread's worktree registration from; absent, the thread directory still goes. */
  readonly git?: Git;
  readonly now?: Now;
}

/**
 * Fleet S5a §3: one prune pass over the thread assets — the archived threads that are not active, and the
 * skill-cache snapshots no run has touched in a month. Called at start and every `pruneIntervalMs`.
 */
export async function pruneThreads(input: PruneThreadsInput): Promise<void> {
  await pruneArchivedThreads({
    homeDir: input.homeDir, threadIds: input.archivedThreadIds, activeThreadIds: input.activeThreadIds,
    ...(input.git ? { git: input.git } : {}),
  });
  await pruneSkillCache(join(input.homeDir, 'skills'), (input.now ?? systemNow)());
}

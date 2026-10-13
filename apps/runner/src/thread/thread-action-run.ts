import type { ThreadAssign } from '@nathapp/fleet-protocol';
import type { JobRow } from '../journal/types';
import { repoDirFor } from '../paths/safe-segment';
import type { ThreadRunDeps, ThreadHostDeps, ThreadPublishInput, ThreadPublishResult } from './thread-job-run';
import { publishThreadDocs } from './thread-publish';
import { discardThreadChanges, type DiscardThreadChangesInput } from './thread-discard';
import type { ThreadEventWriter } from './thread-event-writer';
import { threadWorktreeDir } from './thread-paths';

export type ThreadDiscardInput = { [K in keyof DiscardThreadChangesInput]: DiscardThreadChangesInput[K] };
export type ThreadDiscardResult = { ok: true; tipSha: string } | { ok: false; reason: string; detail?: string };
export type ThreadActionDependencies = Pick<ThreadRunDeps, 'journal' | 'log' | 'now' | 'sleep' | 'logs' | 'tuning'> & {
  readonly mutex: ThreadRunDeps['mutex'];
  readonly host: ThreadHostDeps;
};

/** Execute a no-session PUBLISH or DISCARD THREAD job and persist its single result line. */
export async function runThreadAction(input: {
  readonly deps: ThreadActionDependencies;
  readonly row: JobRow;
  readonly thread: ThreadAssign;
  readonly writer: ThreadEventWriter;
  readonly transition: (to: 'UPLOADING' | 'COMPLETED', reason?: string) => void;
  readonly halted: () => boolean;
}): Promise<void> {
  const { deps, row, thread, writer } = input;
  let reason: string;
  if (thread.action === 'PUBLISH') {
    let result: ThreadPublishResult;
    try {
      const publish = deps.host.publish ?? publishThreadDocs;
      result = await publish({
        git: deps.host.git, mutex: { acquire: deps.mutex.acquire.bind(deps.mutex), isLocked: deps.mutex.isLocked?.bind(deps.mutex) ?? (() => false) },
        repoKey: row.repoKey, worktree: threadWorktreeDir(deps.host.homeDir, thread.threadId), feature: thread.feature,
        threadId: thread.threadId, title: thread.title ?? thread.feature, identity: row.assign.gitIdentity,
      } as ThreadPublishInput);
    } catch {
      result = { ok: false, reason: 'git_error' };
    }
    if (input.halted()) return;
    if (result.ok) { writer.published(result); reason = 'published'; }
    else { writer.publishFailed(result.reason); reason = 'publish_failed'; }
  } else {
    let result: ThreadDiscardResult;
    try {
      const discard = deps.host.discard ?? discardThreadChanges;
      result = await discard({
        git: deps.host.git, homeDir: deps.host.homeDir,
        repoDir: repoDirFor(deps.host.workspaceRoot, row.assign.repo.owner, row.assign.repo.name),
        threadId: thread.threadId, feature: thread.feature, baseRef: row.assign.ref,
      });
    } catch {
      result = { ok: false, reason: 'git_error' };
    }
    if (input.halted()) return;
    if (result.ok) { writer.discarded(result.tipSha); reason = 'discarded'; }
    else { writer.discardFailed(result.reason); reason = 'discard_failed'; }
  }
  const current = input.deps.journal.getJob(row.jobId, row.leaseEpoch);
  if (current === null || current.doneAt !== null) return;
  await input.deps.logs.drain(row.jobId, row.leaseEpoch, input.deps.tuning.logDrainTimeoutMs);
  if (input.halted()) return;
  input.transition('UPLOADING');
  input.transition('COMPLETED', reason);
  input.deps.journal.markDone(row.jobId, row.leaseEpoch);
}

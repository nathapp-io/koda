import type { FleetJobsService } from '../jobs/fleet-jobs.service';
import type { UnstartedTurn } from './domain/chat-thread.domain';
import { threadAuditKey } from './thread-audit';

/**
 * #428: a SESSION turn no runner has started (QUEUED, or ASSIGNED with the ASSIGN never acked) has no runner to send
 * `THREAD_STOP_TURN` to, so Stop cancels the job server-side. The job's terminal transition errors the turn's pending
 * message and publishes the thread events (`ThreadJobEffects`). The thread's own `stop` audit entry is recorded in the
 * same transaction as the cancel, as `command` records it for a running turn.
 *
 * The caller already holds `thread.stop` for this thread (key check plus the repository's creator check). Answers
 * `false`, with nothing written and nothing thrown, when a runner took the turn first: the caller then takes the stop
 * command path, which stops a RUNNING turn or answers `threads.noSession`.
 */
export function cancelUnstartedTurn(
  jobs: Pick<FleetJobsService, 'cancelBeforeRunner'>,
  actorId: string,
  turn: UnstartedTurn,
  thread: { id: string; workspace: boolean },
): Promise<boolean> {
  return jobs.cancelBeforeRunner(actorId, turn.projectId, turn.jobId, {
    key: threadAuditKey('stop', thread.workspace), resourceType: 'thread', resourceId: thread.id,
    projectId: turn.projectId, summary: 'stop cancelled the queued turn',
  });
}

import { maskSecrets } from '../assistant-tool-safety';
import { KODA_REQUEUE_JOB } from '../koda-tool-descriptors';
import { ToolActionError, ToolInputError, type AssistantTool, type ToolContext } from '../assistant-tool.types';
import { isThreadKind } from '../../common/thread-jobs';
import { canTransition } from '../../jobs/job-state';
import type { FleetJobsService } from '../../jobs/fleet-jobs.service';
import type { KnowledgeIndexService } from '../../knowledge/knowledge-index.service';
import { fleetWriteRefusal } from './fleet-write-refusal';
import { asRecord, jobPath } from './tool-input';

/**
 * Fleet S5b 2b2 US-004: `koda_requeue_job` proposes running one terminal job of the thread's project again —
 * CRASHED, FAILED or CANCELLED — and, once the user approves the proposal, requeues it as the requester. A preview
 * never requeues anything, and a THREAD job is never requeued through a tool (2b2-R5): a thread session ends through
 * end-session, which is why `preview` refuses one before it looks at the job's state.
 */

/** 2b2-D3: a job id, as `koda_list_jobs` spells it. */
const MAX_JOB_ID_CHARS = 64;

/** One proposed requeue, as the parser accepted it. */
export interface RequeueJobInput {
  jobId: string;
}

/**
 * `koda_requeue_job` (2b2-D1): one job of the thread's project runs again. `parse` bounds the input, `preview`
 * refuses a job that cannot be requeued and words what the user approves, and `execute` — what an approve runs —
 * requeues it through `FleetJobsService` as the requester.
 */
export function requeueJobTool(fleetJobs: FleetJobsService, knowledge: KnowledgeIndexService): AssistantTool<RequeueJobInput> {
  return {
    descriptor: KODA_REQUEUE_JOB,
    // 2b2-R4: the same CASL tuple the requeue route enforces (`fleet-jobs.controller.ts`), never `create`.
    permission: { kind: 'ability', action: 'update', subject: 'FleetJob' },
    kind: 'write',
    parse(input: unknown): RequeueJobInput {
      const jobId = asRecord(input)['jobId'];
      if (typeof jobId !== 'string' || jobId.length < 1 || jobId.length > MAX_JOB_ID_CHARS) throw new ToolInputError('jobId');
      return { jobId };
    },
    /**
     * 2b2-D4/D5: the text the user approves — the job, the state it is in now and its cost cap — the whole text
     * masked. The job is read through `get`, so one of another project is `not_found` and never previewed; a THREAD
     * job is refused before the state check, so it answers `command` in any state; a state the server cannot move to
     * QUEUED is refused as `state`. The repository is named `owner/name` when it still resolves and by the job's own
     * `repoId` when it does not.
     */
    async preview(ctx: ToolContext, input: RequeueJobInput): Promise<string> {
      const job = await fleetJobs.get(ctx.projectId, input.jobId);
      if (isThreadKind(job.command)) throw new ToolInputError('command');
      if (!canTransition(job.state, 'QUEUED', 'server')) throw new ToolInputError('state');
      const repo = await knowledge.resolveProjectRepo(ctx.projectId, { repoId: job.repoId });
      const named = repo ? `${repo.owner}/${repo.name}` : job.repoId;
      return maskSecrets(
        [
          `Requeue job ${job.id} in ${ctx.projectSlug}:`,
          `${job.command} ${job.feature} on ${named} @ ${job.ref}, now ${job.state}`,
          `max cost: $${job.maxCostUsd}`,
        ].join('\n'),
      );
    },
    /**
     * 2b2-D6: what an approve runs, as the requester. The service re-reads the job under its row lock and refuses a
     * state that moved since the proposal, an already-active feature, a paused budget or a config edit that cannot
     * repeat; whatever it refuses becomes the action's text through `fleetWriteRefusal`, and anything the helper
     * cannot name is rethrown, so `not_found` still answers `not_found`.
     */
    async execute(ctx: ToolContext, input: RequeueJobInput): Promise<string> {
      try {
        const result = await fleetJobs.requeue(ctx.actor.id, ctx.projectId, input.jobId);
        const { id, state } = result.job;
        return `requeued ${id}: ${state} ${jobPath(ctx.projectSlug, id)}`;
      } catch (error) {
        const refusal = fleetWriteRefusal(error);
        if (refusal === null) throw error;
        throw new ToolActionError(`requeue refused: ${refusal}`);
      }
    },
  };
}

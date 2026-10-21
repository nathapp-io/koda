import { maskSecrets } from '../assistant-tool-safety';
import { KODA_CANCEL_JOB } from '../koda-tool-descriptors';
import { ToolActionError, ToolInputError, type AssistantTool, type ToolContext } from '../assistant-tool.types';
import { isThreadKind } from '../../common/thread-jobs';
import { isTerminal } from '../../jobs/job-state';
import type { FleetJobsService } from '../../jobs/fleet-jobs.service';
import type { KnowledgeIndexService } from '../../knowledge/knowledge-index.service';
import { fleetWriteRefusal } from './fleet-write-refusal';
import { asRecord, jobPath } from './tool-input';

/**
 * Fleet S5b 2b2 US-005: `koda_cancel_job` proposes stopping one active job of the thread's project and, once the
 * user approves the proposal, cancels it as the requester. A preview never cancels anything, and a THREAD job is
 * never cancelled through a tool (2b2-R5): a thread session ends through end-session, which is why `preview` refuses
 * one before it looks at the job's state.
 */

/** 2b2-D3: a job id, as `koda_list_jobs` spells it. */
const MAX_JOB_ID_CHARS = 64;

/** The state `FleetJobsService.cancel` answers once it cancelled the job itself, rather than asking the runner to. */
const CANCELLED = 'CANCELLED';

/** One proposed cancel, as the parser accepted it. */
export interface CancelJobInput {
  jobId: string;
}

/**
 * `koda_cancel_job` (2b2-D1): one job of the thread's project stops. `parse` bounds the input, `preview` refuses a
 * job that cannot be cancelled and words what the user approves, and `execute` — what an approve runs — cancels it
 * through `FleetJobsService` as the requester.
 */
export function cancelJobTool(fleetJobs: FleetJobsService, knowledge: KnowledgeIndexService): AssistantTool<CancelJobInput> {
  return {
    descriptor: KODA_CANCEL_JOB,
    key: 'fleet.job.cancel',
    // 2b2-R4: the key the cancel route enforces (`fleet-jobs.controller.ts`), never `fleet.job.create`.
    kind: 'write',
    parse(input: unknown): CancelJobInput {
      const jobId = asRecord(input)['jobId'];
      if (typeof jobId !== 'string' || jobId.length < 1 || jobId.length > MAX_JOB_ID_CHARS) throw new ToolInputError('jobId');
      return { jobId };
    },
    /**
     * 2b2-D4/D5: the text the user approves — the job and the state it is in now — the whole text masked. The job is
     * read through `get`, so one of another project is `not_found` and never previewed; a THREAD job is refused
     * before the state check, so it answers `command` in any state; a state that is already terminal cannot be
     * cancelled and is refused as `state`. CONFIG_EDIT and CONFIG_DRIFT jobs are not restricted: cancel stops them
     * the way the route does. The repository is named `owner/name` when it still resolves and by the job's own
     * `repoId` when it does not.
     */
    async preview(ctx: ToolContext, input: CancelJobInput): Promise<string> {
      const job = await fleetJobs.get(ctx.projectId, input.jobId);
      if (isThreadKind(job.command)) throw new ToolInputError('command', `a ${job.command} job cannot be cancelled with this tool`);
      if (isTerminal(job.state)) throw new ToolInputError('state', `the job is ${job.state} and has already ended`);
      const repo = await knowledge.resolveProjectRepo(ctx.projectId, { repoId: job.repoId });
      const named = repo ? `${repo.owner}/${repo.name}` : job.repoId;
      return maskSecrets(
        [
          `Cancel job ${job.id} in ${ctx.projectSlug}:`,
          `${job.command} ${job.feature} on ${named} @ ${job.ref}, now ${job.state}`,
        ].join('\n'),
      );
    },
    /**
     * 2b2-D6: what an approve runs, as the requester. `canOperate` is always true (2b2-R4): the key the tool
     * requires is what authorises the cancel, so the route's own-job path is not exposed. The service re-reads the job
     * under its row lock and refuses a state that moved since the proposal; whatever it refuses becomes the action's
     * text through `fleetWriteRefusal`, and anything the helper cannot name is rethrown, so `not_found` still
     * answers `not_found`.
     */
    async execute(ctx: ToolContext, input: CancelJobInput): Promise<string> {
      try {
        const job = await fleetJobs.cancel(ctx.actor.id, ctx.projectId, input.jobId, true);
        return job.state === CANCELLED
          ? `cancelled ${job.id} ${jobPath(ctx.projectSlug, job.id)}`
          : `cancel requested for ${job.id} (${job.state}) ${jobPath(ctx.projectSlug, job.id)}`;
      } catch (error) {
        const refusal = fleetWriteRefusal(error);
        if (refusal === null) throw error;
        throw new ToolActionError(`cancel refused: ${refusal}`);
      }
    },
  };
}

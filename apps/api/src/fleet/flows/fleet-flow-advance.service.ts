import { Inject, Injectable } from '@nestjs/common';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { bookkeeping } from '../../action-context/audit-coverage';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { FleetActivityService } from '../activity/fleet-activity.service';
import type { FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import { FleetReposService } from '../repos/fleet-repos.service';
import { prNumberFor } from '../sync/pr-attribution.service';
import { ThreadsService } from '../threads/threads.service';
import { FLEET_FLOW_REPOSITORY, type FleetFlowRecord, type IFleetFlowRepository } from './domain/fleet-flow.domain';
import { FLEET_FLOW_STEP_REPOSITORY, type IFleetFlowStepRepository } from './domain/fleet-flow-step.domain';
import { decideFlowStep, type FlowJobView, type FlowStepAction, type FlowStepInput } from './flow-step-decision';
import { FLOW_STOP_DETAIL_MAX, type FlowStep } from './flow-steps';

/**
 * `FLEET_FLOW_PR_WAIT_MS`'s default (design, "`RUN` waits for its PR"). US-017 moves it onto
 * `IFleetConfig.flowPrWaitMs`; until then this pass uses the documented default.
 */
const FLOW_PR_WAIT_MS = 1_800_000;

/** The repo facts `prNumberFor` needs; `FleetReposService.findReviewRepo` returns them. */
type ReviewRepo = { owner: string; name: string };

/**
 * Fleet flow F3 (US-012): one pass of the advancement engine's decide phase.
 *
 * A pass reads the flow and its latest job unlocked — only to select the parent lock and to read the
 * forge/PR facts before any transaction opens — then locks the parent (thread or repo) and the flow,
 * re-reads the authoritative state and job under those locks, refreshes `spentUsd` when the sum of the
 * flow's job costs changed, and asks `decideFlowStep` what to do. Stops and completions are written
 * here, inside that transaction, each with its `system.flow.advance` audit entry and its activity row.
 *
 * A `dispatch` decision ends this pass with nothing written: the dispatch phase (US-013) and its
 * guards (US-014, US-015) come later.
 */
@Injectable()
export class FleetFlowAdvanceService {
  constructor(
    @Inject(FLEET_FLOW_REPOSITORY) private readonly flows: IFleetFlowRepository,
    @Inject(FLEET_FLOW_STEP_REPOSITORY) private readonly steps: IFleetFlowStepRepository,
    private readonly threads: ThreadsService,
    private readonly repos: FleetReposService,
    private readonly activity: FleetActivityService,
    private readonly audit: AuditRecorder,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  async advance(flowId: string, now: Date): Promise<void> {
    // This story builds the pass up to the decision: the dispatch phase (no transaction held) and the
    // record phase are US-013, and the guards before a dispatch are US-014 and US-015.
    await this.decide(flowId, now);
  }

  /**
   * Decide (one transaction). The unlocked read and the forge reads it enables are discarded for the
   * decision itself: state, features and the latest job are read again under the locks, so a stop, a
   * re-ask or a dispatch another pass made in between is what this pass acts on.
   */
  private async decide(flowId: string, now: Date): Promise<void> {
    const flow = await this.flows.findById(flowId);
    if (!flow) return;

    // The PR number of a RUN that ended is read before the transaction: an HTTP-forge read never runs
    // with a lock or a transaction open.
    const latest = await this.steps.latestJob(flow.id);
    const reviewRepo = latest !== null && latest.flowStep === 'RUN' && latest.resultPrUrl !== null
      ? await this.repos.findReviewRepo(flow.repoId)
      : null;

    await this.txManager.run(async () => {
      if (!(await this.lockParent(flow))) return;
      const current = await this.flows.lockById(flow.id);
      if (!current || (current.state !== 'APPROVED' && current.state !== 'RUNNING')) return;

      await this.refreshSpent(current);
      const job = await this.steps.latestJob(current.id);
      const action = decideFlowStep(await this.decisionInput(current, job, reviewRepo, now));
      await this.writeDecision(current, job, action, now);
    });
  }

  /**
   * Parent, then flow (the create and re-publish lock order). A thread-entry flow takes the thread row;
   * a nax-entry flow takes its repo row. A parent row deleted meanwhile ends the pass: nothing below it
   * can be decided.
   */
  private async lockParent(flow: FleetFlowRecord): Promise<boolean> {
    const parent = flow.threadId !== null
      ? await this.threads.lockForFlowTransition(flow.projectId, flow.threadId)
      : await this.repos.lockById(flow.repoId);
    return parent !== null;
  }

  /**
   * `spentUsd` is the sum of the flow's jobs' costs, recomputed on every pass; the write happens only
   * when it moved (a late ingest raises a job's cost). Both sides are 4-place decimal strings, so they
   * compare exactly — never as floats.
   */
  private async refreshSpent(flow: FleetFlowRecord): Promise<void> {
    const sum = await this.steps.sumCost(flow.id);
    if (sum === flow.spentUsd) return;
    await bookkeeping('fleet.flow-bookkeeping', () => this.steps.setSpent(flow.id, sum));
  }

  private async decisionInput(
    flow: FleetFlowRecord,
    job: FleetJobRecord | null,
    reviewRepo: ReviewRepo | null,
    now: Date,
  ): Promise<FlowStepInput> {
    return {
      state: flow.state,
      featureCount: flow.features.length,
      // An APPROVED or RUNNING flow was approved before it became live; the fallback only widens the type.
      approvedAt: flow.approvedAt ?? now,
      latestJob: job === null ? null : this.jobView(job, reviewRepo),
      now,
      prWaitMs: FLOW_PR_WAIT_MS,
      // Only a finished RUN needs the ingest's verdict on its PR; every other step ignores the flag.
      ingestSettled: job !== null && job.flowStep === 'RUN'
        ? await this.steps.ingestSettled(job.id, job.leaseEpoch)
        : false,
      featurePrNumber: flow.features[0]?.prNumber ?? null,
    };
  }

  /**
   * The job as the decision reads it. The PR number comes from `resultPrUrl` — bundle ingest fills that
   * URL after the job ends, not a column of its own — and only when it names this flow's repo.
   */
  private jobView(job: FleetJobRecord, reviewRepo: ReviewRepo | null): FlowJobView {
    return {
      id: job.id,
      step: job.flowStep as FlowStep,
      state: job.state,
      stateReason: job.stateReason,
      queuedAt: job.queuedAt,
      finishedAt: job.finishedAt,
      prNumber: job.flowStep === 'RUN' && job.resultPrUrl !== null && reviewRepo !== null
        ? prNumberFor({ provider: 'github', owner: reviewRepo.owner, name: reviewRepo.name }, job.resultPrUrl)
        : null,
      agentOutput: job.agentResult?.output ?? null,
      resultBranch: job.resultBranch,
      resultSha: job.resultSha,
      fixReady: job.fixReady ?? null,
    };
  }

  /**
   * The write half of the decide phase. `skip`, `wait` and `dispatch` write nothing here; a stop and a
   * completion are written with the activity and the audit entry they belong to, in this transaction.
   */
  private async writeDecision(
    flow: FleetFlowRecord,
    job: FleetJobRecord | null,
    action: FlowStepAction,
    now: Date,
  ): Promise<void> {
    if (action.kind === 'stop') {
      // A flow's stopDetail is one column and one activity payload: keep both bounded by the same cap.
      const detail = action.detail.slice(0, FLOW_STOP_DETAIL_MAX);
      await this.flows.stop(flow.id, action.reason, now, detail);
      await this.record(flow, 'flow stopped', 'flow.stopped', {
        flowId: flow.id, stopReason: action.reason, detail, step: job?.flowStep ?? null, jobId: job?.id ?? null,
      });
      return;
    }
    if (action.kind === 'complete') {
      await this.steps.complete(flow.id, now);
      await this.record(flow, 'flow completed', 'flow.completed', {
        flowId: flow.id, step: job?.flowStep ?? null, jobId: job?.id ?? null,
      });
    }
  }

  private async record(
    flow: FleetFlowRecord,
    summary: string,
    activityAction: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      key: 'system.flow.advance', resourceType: 'flow', resourceId: flow.id, projectId: flow.projectId, summary,
    });
    await this.activity.record({
      actorType: 'SYSTEM', actorId: 'flow', action: activityAction, entityType: 'flow', entityId: flow.id,
      projectId: flow.projectId, payload,
    });
  }
}

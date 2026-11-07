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
import {
  FLEET_FLOW_STEP_REPOSITORY, type IFleetFlowStepRepository, type LatestFlowJob,
} from './domain/fleet-flow-step.domain';
import { decideFlowStep, type FlowJobView, type FlowStepAction, type FlowStepInput } from './flow-step-decision';
import { FLOW_STOP_DETAIL_MAX, type FlowStep } from './flow-steps';

/**
 * `FLEET_FLOW_PR_WAIT_MS`'s default (design, "`RUN` waits for its PR"). US-017 moves it onto
 * `IFleetConfig.flowPrWaitMs`; until then this pass uses the documented default.
 */
const FLOW_PR_WAIT_MS = 1_800_000;

/**
 * Fleet flow F3 (US-012): one pass of the advancement engine's decide phase.
 *
 * A pass reads the flow unlocked — only to select the parent lock — then locks the parent (thread or
 * repo) and the flow, re-reads the authoritative state, refreshes `spentUsd` when the sum of the flow's
 * job costs changed, and reads the flow's latest job together with its ingest status. Everything the
 * decision acts on comes from under those locks or from that one statement, so a job an ingest finished
 * meanwhile cannot be judged by facts gathered before it did. Stops and completions are written inside
 * that transaction, each with its `system.flow.advance` audit entry and its activity row.
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
   * Decide (one transaction). The unlocked read only selects the parent lock: state, features and the
   * job are read again under the locks, so a stop, a re-ask or a dispatch another pass made in between
   * is what this pass acts on.
   */
  private async decide(flowId: string, now: Date): Promise<void> {
    const flow = await this.flows.findById(flowId);
    if (!flow) return;

    await this.txManager.run(async () => {
      if (!(await this.lockParent(flow))) return;
      const current = await this.flows.lockById(flow.id);
      if (!current || (current.state !== 'APPROVED' && current.state !== 'RUNNING')) return;

      await this.refreshSpent(current);
      // One statement pairs the job with the ingest status of its own lease: a RUN's `resultPrUrl` and
      // that mark commit together, so read apart they could stop a flow whose PR had just been recorded.
      const latest = await this.steps.latestJobWithIngest(current.id);
      const action = decideFlowStep(await this.decisionInput(current, latest, now));
      await this.writeDecision(current, latest?.job ?? null, action, now);
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

  private async decisionInput(flow: FleetFlowRecord, latest: LatestFlowJob | null, now: Date): Promise<FlowStepInput> {
    return {
      state: flow.state,
      featureCount: flow.features.length,
      // An APPROVED or RUNNING flow was approved before it became live; the fallback only widens the type.
      approvedAt: flow.approvedAt ?? now,
      latestJob: latest === null ? null : await this.jobView(flow, latest.job),
      now,
      prWaitMs: FLOW_PR_WAIT_MS,
      // Only a finished RUN consults this, and it arrives with the row it belongs to.
      ingestSettled: latest?.ingestSettled ?? false,
      featurePrNumber: flow.features[0]?.prNumber ?? null,
    };
  }

  /**
   * The job as the decision reads it. A RUN's PR number comes from `resultPrUrl` — bundle ingest fills
   * that URL after the job ends, there is no PR column — and only when it names this flow's repo. The
   * repo row is a plain database read (no forge call), so it is resolved here against the row this pass
   * already read, never from an earlier snapshot a concurrent ingest may have moved past.
   */
  private async jobView(flow: FleetFlowRecord, job: FleetJobRecord): Promise<FlowJobView> {
    return {
      id: job.id,
      step: job.flowStep as FlowStep,
      state: job.state,
      stateReason: job.stateReason,
      queuedAt: job.queuedAt,
      finishedAt: job.finishedAt,
      prNumber: await this.prNumberOf(flow, job),
      agentOutput: job.agentResult?.output ?? null,
      resultBranch: job.resultBranch,
      resultSha: job.resultSha,
      fixReady: job.fixReady ?? null,
    };
  }

  private async prNumberOf(flow: FleetFlowRecord, job: FleetJobRecord): Promise<number | null> {
    if (job.flowStep !== 'RUN' || job.resultPrUrl === null) return null;
    const repo = await this.repos.findReviewRepo(flow.repoId);
    return repo === null
      ? null
      : prNumberFor({ provider: 'github', owner: repo.owner, name: repo.name }, job.resultPrUrl);
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

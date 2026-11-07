import { Inject, Injectable } from '@nestjs/common';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { BudgetPausedException } from '../budgets/budget.exceptions';
import { FleetDispatchException } from '../jobs/fleet-dispatch.exception';
import { FleetJobsService } from '../jobs/fleet-jobs.service';
import { buildStepDispatch } from './flow-step-dispatch';
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

type DispatchAction = Extract<FlowStepAction, { kind: 'dispatch' }>;
interface DispatchPass {
  flow: FleetFlowRecord;
  action: DispatchAction;
  plan: FleetJobRecord | null;
}

/** Decide under parent/flow locks, dispatch outside a transaction, then re-lock to record progress. */
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
    private readonly jobs: FleetJobsService,
  ) {}

  async advance(flowId: string, now: Date): Promise<void> {
    const pass = await this.decide(flowId, now);
    // US-016 adds the head claim/adoption path here. Never dispatch an unclaimed REVIEW.
    if (!pass || pass.action.step === 'REVIEW') return;
    const { flow, action, plan } = pass;
    const body = buildStepDispatch({
      flow, feature: flow.features[0], step: action.step,
      // US-014 supplies the guarded remaining cap; US-017 moves the agent default into FLEET_CFG.
      remainingCapUsd: flow.costCapUsd, reviewAgent: 'Explore',
      ...(plan ? { plan } : {}), ...(action.pr ? { pr: action.pr } : {}),
    });
    let jobId: string;
    try {
      const result = await this.jobs.dispatch(flow.createdById, flow.projectId, body, {
        flowId: flow.id, flowStep: action.step, auditKey: 'system.flow.advance',
      });
      jobId = result.job.id;
    } catch (error) {
      if (!(error instanceof BudgetPausedException || error instanceof ConflictAppException
        || error instanceof ValidationAppException || error instanceof NotFoundAppException
        || error instanceof FleetDispatchException)) throw error;
      const reason = error instanceof BudgetPausedException ? 'budget_paused' : 'dispatch_refused';
      const detail = `${action.step}: ${dispatchRefusalReason(error)}`;
      await this.txManager.run(async () => {
        const current = await this.lockLive(flow);
        if (!current) return;
        await this.writeDecision(current, null, { kind: 'stop', reason, detail }, now);
      });
      return;
    }
    await this.txManager.run(async () => {
      const current = await this.lockLive(flow);
      if (!current) return; // A stop/re-ask does not cancel the dispatched job.
      await this.recordStep(current, action.step, jobId, action.pr?.number);
    });
  }

  /** Recheck the approval generation as well as state: a re-ask may already have been approved again. */
  private async lockLive(previous: FleetFlowRecord): Promise<FleetFlowRecord | null> {
    if (!(await this.lockParent(previous))) return null;
    const current = await this.flows.lockById(previous.id);
    if (!current || (current.state !== 'APPROVED' && current.state !== 'RUNNING')) return null;
    if (current.specSha !== previous.specSha
      || current.approvedAt?.getTime() !== previous.approvedAt?.getTime()) return null;
    return current;
  }

  /** Called only with the parent and flow locked, including crash recovery in the decide transaction. */
  private async recordStep(flow: FleetFlowRecord, step: FlowStep, jobId: string, prNumber?: number): Promise<void> {
    const feature = flow.features[0];
    await this.steps.markStep(flow.id, feature.id, step, {
      flowState: 'RUNNING', ...(prNumber !== undefined ? { prNumber } : {}),
    });
    if (flow.state === 'APPROVED') {
      await this.record(flow, 'flow started', 'flow.started', {
        approvalMode: flow.approvalMode, approverId: flow.approverId,
      });
    }
    await this.record(flow, `flow step ${step}`, 'flow.step', { step, jobId });
  }

  /**
   * Decide (one transaction). The unlocked read only selects the parent lock: state, features and the
   * job are read again under the locks, so a stop, a re-ask or a dispatch another pass made in between
   * is what this pass acts on.
   */
  private async decide(flowId: string, now: Date): Promise<DispatchPass | undefined> {
    const flow = await this.flows.findById(flowId);
    if (!flow) return;

    return this.txManager.run(async () => {
      if (!(await this.lockParent(flow))) return;
      const current = await this.flows.lockById(flow.id);
      if (!current || (current.state !== 'APPROVED' && current.state !== 'RUNNING')) return;

      await this.refreshSpent(current);
      // One statement pairs the job with the ingest status of its own lease: a RUN's `resultPrUrl` and
      // that mark commit together, so read apart they could stop a flow whose PR had just been recorded.
      const latest = await this.steps.latestJobWithIngest(current.id);
      const input = await this.decisionInput(current, latest, now);
      const action = decideFlowStep(input);
      if (current.features.length !== 1) return;
      // The insert carries the flow link even if dispatch/record crashed. Reconcile once, then let the
      // next tick decide from RUNNING. An older approval's job must never be mistaken for this start.
      const job = latest?.job;
      const recoverable = current.state === 'RUNNING' || (job?.flowStep === 'SPEC_REVIEW'
        && current.approvedAt !== null && job.queuedAt.getTime() >= current.approvedAt.getTime());
      if (job && recoverable && (current.state === 'APPROVED'
        || current.features[0].currentStep !== job.flowStep || current.features[0].state !== 'RUNNING')) {
        await this.recordStep(current, job.flowStep as FlowStep, job.id, input.latestJob?.prNumber ?? undefined);
        return;
      }
      await this.writeDecision(current, job ?? null, action, now);
      if (action.kind !== 'dispatch') return;
      // Guard seams: cap/creator checks (US-014), then the pre-push SHA/re-ask check (US-015).
      const plan = action.step === 'PRD_REVIEW' || action.step === 'RUN'
        ? await this.steps.latestJobForStep(current.id, 'PLAN') : null;
      return { flow: current, action, plan };
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

/** Match ReviewHeadDispatcher: only a string validation reason is safe to expose as the detail. */
function dispatchRefusalReason(error: Error): string {
  if (error instanceof ValidationAppException) {
    const response: unknown = error.getResponse();
    if (typeof response === 'object' && response !== null && 'args' in response) {
      const args = response.args;
      if (typeof args === 'object' && args !== null && 'reason' in args && typeof args.reason === 'string') {
        return args.reason;
      }
    }
  }
  return error.constructor.name;
}

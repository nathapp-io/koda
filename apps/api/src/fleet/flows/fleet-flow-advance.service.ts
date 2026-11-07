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
import { decideFlowStep, type FlowJobView, type FlowStepAction, type FlowStopReason, type FlowStepInput } from './flow-step-decision';
import { FLOW_STOP_DETAIL_MAX, type FlowStep } from './flow-steps';
import { FleetReviewClaimService } from '../reviews/fleet-review-claim.service';
import { remainingCapUsd } from './flow-step-dispatch';
import { mayDispatch } from '../schedules/schedule-access';
import { PermissionService } from '../../permissions/permission.service';
import type { PrincipalRef } from '../../permissions/permissions.types';
import { FleetFlowsService } from './fleet-flows.service';
import { GitHubAppClient } from '../git-broker/github-app-client';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { isTerminal } from '../jobs/job-state';

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
  remainingCapUsd: string;
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
    private readonly permissions: PermissionService,
    private readonly flowService: FleetFlowsService,
    private readonly github: GitHubAppClient,
    private readonly reviews: FleetReviewClaimService,
  ) {}

  async advance(flowId: string, now: Date): Promise<void> {
    const pass = await this.decide(flowId, now);
    if (!pass) return;
    if (pass.action.step === 'REVIEW') {
      await this.advanceReview(pass, now);
      return;
    }
    const { flow, action } = pass;
    let jobId: string;
    try {
      jobId = await this.dispatchStep(pass);
    } catch (error) {
      await this.refuseDispatch(flow, action.step, error, now);
      return;
    }
    await this.txManager.run(async () => {
      const current = await this.lockLive(flow);
      if (!current) return; // A stop/re-ask does not cancel the dispatched job.
      await this.recordStep(current, action.step, jobId, action.pr?.number);
    });
  }

  /**
   * `REVIEW` goes through the review head claim, so an auto-review of the same head is adopted instead of
   * dispatched twice. The claim key is the head the `RUN` pushed (`resultSha`): nothing else writes the
   * feature branch between the `RUN` and this `REVIEW`. Every claim write happens outside a transaction.
   */
  private async advanceReview(pass: DispatchPass, now: Date): Promise<void> {
    const { flow, action } = pass;
    const pr = action.pr;
    // No pushed head means no claim key: nothing to claim and nothing safe to dispatch. Wait for the next pass.
    if (!pr?.headSha) return;

    const claim = await this.reviews.claimHead(flow.repoId, pr.number, pr.headSha, now);
    // A live pass owns this head but has not linked its job yet: this pass waits rather than duplicate it.
    if (claim.kind === 'busy') return;
    if (claim.kind === 'failed') {
      await this.writeStop(flow, 'dispatch_refused', `REVIEW: ${claim.outcome}`, now);
      return;
    }
    if (claim.kind === 'owned') {
      await this.adoptReview(pass, claim.jobId, now);
      return;
    }

    let jobId: string;
    try {
      jobId = await this.dispatchStep(pass);
    } catch (error) {
      // The claim is ours and the dispatch failed: release it so a later pass can retry this head,
      // then handle the error exactly as the other steps do.
      await this.reviews.release(claim.claimId);
      await this.refuseDispatch(flow, 'REVIEW', error, now);
      return;
    }
    // Link the claim before the record phase: the job exists now, so a record that skips still leaves a
    // head whose claim points at it, and the next pass adopts instead of dispatching again.
    await this.reviews.markDispatched(claim.claimId, jobId);
    await this.txManager.run(async () => {
      const current = await this.lockLive(flow);
      if (!current) return;
      await this.recordStep(current, 'REVIEW', jobId, pr.number);
    });
  }

  /**
   * The head already has a job (an auto-review for the same repo, PR and head). Adopt it into this flow in
   * the record transaction, after the flow-state check; a job another flow already owns is a refusal.
   */
  private async adoptReview(pass: DispatchPass, jobId: string, now: Date): Promise<void> {
    const { flow, action } = pass;
    await this.txManager.run(async () => {
      const current = await this.lockLive(flow);
      if (!current) return;
      if (!(await this.jobs.adoptForFlow(jobId, current.id, 'REVIEW'))) {
        await this.writeDecision(current, null, {
          kind: 'stop', reason: 'dispatch_refused', detail: 'REVIEW: head claimed by another flow',
        }, now);
        return;
      }
      await this.recordStep(current, 'REVIEW', jobId, action.pr?.number);
    });
  }

  /** The exact body for the step the decision chose, dispatched for the flow's creator outside a transaction. */
  private async dispatchStep(pass: DispatchPass): Promise<string> {
    const { flow, action, plan } = pass;
    const body = buildStepDispatch({
      flow, feature: flow.features[0], step: action.step,
      // US-014 supplies the guarded remaining cap; US-017 moves the agent default into FLEET_CFG.
      remainingCapUsd: pass.remainingCapUsd, reviewAgent: 'Explore',
      ...(plan ? { plan } : {}), ...(action.pr ? { pr: action.pr } : {}),
    });
    const result = await this.jobs.dispatch(flow.createdById, flow.projectId, body, {
      flowId: flow.id, flowStep: action.step, auditKey: 'system.flow.advance',
    });
    return result.job.id;
  }

  /** A declared dispatch refusal stops the flow; any other error propagates after the caller released its claim. */
  private async refuseDispatch(flow: FleetFlowRecord, step: FlowStep, error: unknown, now: Date): Promise<void> {
    if (!(error instanceof BudgetPausedException || error instanceof ConflictAppException
      || error instanceof ValidationAppException || error instanceof NotFoundAppException
      || error instanceof FleetDispatchException)) throw error;
    const reason = error instanceof BudgetPausedException ? 'budget_paused' : 'dispatch_refused';
    await this.writeStop(flow, reason, `${step}: ${dispatchRefusalReason(error)}`, now);
  }

  /** The write half of a refusal: re-read under the parent/flow locks, then stop with activity and audit. */
  private async writeStop(flow: FleetFlowRecord, reason: FlowStopReason, detail: string, now: Date): Promise<void> {
    await this.txManager.run(async () => {
      const current = await this.lockLive(flow);
      if (!current) return;
      await this.writeDecision(current, null, { kind: 'stop', reason, detail }, now);
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

    // Forge I/O is only a preflight hint. Re-read state/jobs under locks below, and never let a
    // transient forge failure commit even a bookkeeping write. No token crosses this boundary.
    let forgeHead: string | null | undefined;
    try {
      forgeHead = await this.readSpecHead(flow);
    } catch (error) {
      if (error instanceof RepoCheckException) return;
      throw error;
    }

    return this.txManager.run(async () => {
      const parent = await this.lockParent(flow);
      if (!parent) return;
      const current = await this.flows.lockById(flow.id);
      if (!current || (current.state !== 'APPROVED' && current.state !== 'RUNNING')) return;

      const spentUsd = await this.refreshSpent(current);
      // One statement pairs the job with the ingest status of its own lease: a RUN's `resultPrUrl` and
      // that mark commit together, so read apart they could stop a flow whose PR had just been recorded.
      const snapshot = await this.steps.latestJobWithIngest(current.id);
      // A dispatch can finish preflight and insert after a different spec was re-approved. queuedAt
      // alone cannot identify that approval's review: ignore the old SHA for both decision and recovery,
      // otherwise we would either adopt stale work or wait forever instead of reviewing the new spec.
      const latest = snapshot?.job.flowStep === 'SPEC_REVIEW' && snapshot.job.ref !== current.specSha
        ? null : snapshot;
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
      if (action.kind !== 'dispatch') {
        await this.writeDecision(current, job ?? null, action, now);
        return;
      }
      // Dispatch guards run in order, against the freshly reconciled spend and the original creator.
      const remaining = remainingCapUsd(current.costCapUsd, spentUsd);
      if (remaining === null) {
        await this.writeDecision(current, job ?? null, {
          kind: 'stop', reason: 'cost_cap', detail: `spent ${spentUsd} of cap ${current.costCapUsd}`,
        }, now);
        return;
      }
      const creatorRef: PrincipalRef = { type: current.createdByType, id: current.createdById };
      const access = await this.steps.creatorAccess(creatorRef);
      const keys = await this.permissions.effectiveKeys(creatorRef, { projectId: current.projectId });
      if (!mayDispatch(access, keys)) {
        await this.writeDecision(current, job ?? null, {
          kind: 'stop', reason: 'creator_lost_access', detail: 'flow creator lost dispatch access',
        }, now);
        return;
      }
      if (action.step === 'SPEC_REVIEW' || action.step === 'PLAN') {
        // A different approval/target or a newly eligible step needs its own preflight next pass.
        // In particular, never re-ask a freshly approved spec using an older generation's head.
        if (current.threadId === null && (forgeHead === undefined
          || current.repoId !== flow.repoId || current.branch !== flow.branch || current.specSha !== flow.specSha
          || current.approvedAt?.getTime() !== flow.approvedAt?.getTime())) return;
        if (current.threadId === null && forgeHead === null) {
          await this.writeDecision(current, job ?? null, {
            kind: 'stop', reason: 'dispatch_refused', detail: `${action.step}: repo not connected`,
          }, now);
          return;
        }
        const specSha = current.threadId !== null ? parent.publishedSha : forgeHead;
        if (specSha == null) return;
        if (specSha !== current.specSha) {
          await this.flowService.reaskLocked(current, specSha, now);
          return;
        }
      }
      const plan = action.step === 'PRD_REVIEW' || action.step === 'RUN'
        ? await this.steps.latestJobForStep(current.id, 'PLAN') : null;
      return { flow: current, action, plan, remainingCapUsd: remaining };
    });
  }

  /**
   * Parent, then flow (the create and re-publish lock order). A thread-entry flow takes the thread row;
   * a nax-entry flow takes its repo row. A parent row deleted meanwhile ends the pass: nothing below it
   * can be decided.
   */
  private async lockParent(flow: FleetFlowRecord): Promise<{ publishedSha?: string | null } | null> {
    if (flow.threadId !== null) {
      return this.threads.lockForFlowTransition(flow.projectId, flow.threadId);
    }
    return (await this.repos.lockById(flow.repoId)) === null ? null : {};
  }

  /** undefined: not a candidate; null: disconnected. Only a head SHA survives forge preflight. */
  private async readSpecHead(flow: FleetFlowRecord): Promise<string | null | undefined> {
    if (flow.threadId !== null || (flow.state !== 'APPROVED' && flow.state !== 'RUNNING')) return;
    const snapshot = await this.steps.latestJobWithIngest(flow.id);
    const latest = snapshot?.job;
    if (flow.state !== 'APPROVED' && latest
      && !(latest.flowStep === 'SPEC_REVIEW' && isTerminal(latest.state))) return;
    const repo = await this.repos.findReviewRepo(flow.repoId);
    if (!repo || repo.githubInstallationId === null) return null;
    const { token } = await this.github.mintReadOnlyToken(repo.githubInstallationId, repo.name);
    return this.github.getBranchHead(token, repo.owner, repo.name, flow.branch);
  }

  /**
   * `spentUsd` is the sum of the flow's jobs' costs, recomputed on every pass; the write happens only
   * when it moved (a late ingest raises a job's cost). Both sides are 4-place decimal strings, so they
   * compare exactly — never as floats.
   */
  private async refreshSpent(flow: FleetFlowRecord): Promise<string> {
    const sum = await this.steps.sumCost(flow.id);
    if (sum !== flow.spentUsd) {
      await bookkeeping('fleet.flow-bookkeeping', () => this.steps.setSpent(flow.id, sum));
    }
    return sum;
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

import { Inject, Injectable, Logger } from '@nestjs/common';
import { OutboxService } from '@nathapp/nestjs-outbox';
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
import { FLEET_FLOW_REPOSITORY, type FleetFlowFeatureRecord, type FleetFlowRecord, type IFleetFlowRepository } from './domain/fleet-flow.domain';
import { groupFindingsByFeature, nextFlowFeature } from './flow-features';
import {
  FLEET_FLOW_STEP_REPOSITORY, type IFleetFlowStepRepository, type LatestFlowJob,
} from './domain/fleet-flow-step.domain';
import { decideFlowStep, type ApplyCallsAction, type ApplyPrdEditsAction, type ApplyRulingsAction, type FlowJobView, type FlowStepAction, type FlowStopReason, type FlowStepInput } from './flow-step-decision';
import { FleetFlowCallsService, type FleetFlowCallsTarget } from './fleet-flow-calls.service';
import { runFeatureStart, runMergeWatch, type FeaturePassDeps, type FeatureStartBase } from './fleet-flow-feature-passes';
import { ruleTaskItems, type FlowOpenItem, type FlowRuling, type FlowRuleGuidance } from './flow-rulings';
import { FLOW_CALL_TEXT_MAX, oneLine, safeFlowJsonText, truncateFlowText, type FlowAnswer, type FlowQuestion } from './flow-calls';
import { FleetPrRulingsService } from '../rulings/fleet-pr-rulings.service';
import { FLOW_STOP_DETAIL_MAX, type FlowStep } from './flow-steps';
import { FleetReviewClaimService } from '../reviews/fleet-review-claim.service';
import { prNumberOfReviewFeature } from '../common/review-jobs';
import { remainingCapUsd } from './flow-step-dispatch';
import { mayDispatch } from '../schedules/schedule-access';
import { PermissionService } from '../../permissions/permission.service';
import type { PrincipalRef } from '../../permissions/permissions.types';
import { FleetFlowsService } from './fleet-flows.service';
import { GitHubAppClient } from '../git-broker/github-app-client';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { isTerminal } from '../jobs/job-state';
import { FLEET_CFG, type IFleetConfig } from '../../config/fleet.config';
import { FLEET_FLOW_QUESTIONS, FLEET_FLOW_STOPPED } from '../../notifications/fleet/fleet-notification-events';

type DispatchAction = Extract<FlowStepAction, { kind: 'dispatch' }>;
/** US-011: a later feature starts on its own branch; the start pass creates it outside a transaction. */
interface StartFeatureAction { kind: 'start_feature'; featureId: string; base: FeatureStartBase }
type FlowPassAction = DispatchAction | ApplyCallsAction | ApplyRulingsAction | ApplyPrdEditsAction | StartFeatureAction;
interface DispatchPass<A extends FlowPassAction = FlowPassAction> {
  flow: FleetFlowRecord;
  /**
   * The feature the pass runs for (US-008): its own jobs, its own ids and, for a later feature,
   * its own branch. The flow's first feature is the one at position 0.
   */
  feature: FleetFlowFeatureRecord;
  action: A;
  plan: FleetJobRecord | null;
  remainingCapUsd: string;
  rule?: { ref: string; prNumber: number; items: FlowOpenItem[]; guidance: FlowRuleGuidance | null };
}

/** Decide under parent/flow locks, dispatch or apply calls outside a transaction, then re-lock to record progress. */
@Injectable()
export class FleetFlowAdvanceService {
  private readonly logger = new Logger(FleetFlowAdvanceService.name);

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
    @Inject(FLEET_CFG) private readonly config: Pick<IFleetConfig, 'flowPrWaitMs' | 'flowReviewAgent'>,
    private readonly calls: FleetFlowCallsService,
    private readonly outbox: OutboxService,
    private readonly rulings: FleetPrRulingsService,
  ) {}

  async advance(flowId: string, now: Date): Promise<void> {
    const live = await this.flows.findById(flowId);
    if (!live) return;
    // US-012: a flow that waits for a merge is watched, not decided: the pass polls the awaited
    // PRs and resumes the flow when the next feature can start.
    if (live.state === 'WAITING_MERGE') {
      await runMergeWatch(this.featurePassDeps(), { flow: live, now });
      return;
    }
    const pass = await this.decide(live, now);
    if (!pass) return;
    const { flow, feature, action } = pass;
    if (action.kind === 'apply_calls') {
      await this.advanceCalls(flow, feature, action, pass.plan, now);
      return;
    }
    if (action.kind === 'apply_rulings') {
      await this.advanceRulings(flow, feature, action);
      return;
    }
    if (action.kind === 'apply_prd_edits') {
      await this.advancePrdEdits(flow, feature, action, pass.plan, now);
      return;
    }
    if (action.kind === 'start_feature') {
      await this.advanceStart({ ...pass, action }, now);
      return;
    }
    const dispatchPass = { ...pass, action };
    if (action.step === 'REVIEW') {
      await this.advanceReview(dispatchPass, now);
      return;
    }
    let jobId: string;
    try {
      jobId = await this.dispatchStep(dispatchPass);
    } catch (error) {
      await this.refuseDispatch(flow, feature, action.step, error, now);
      return;
    }
    await this.txManager.run(async () => {
      const current = await this.lockLive(flow);
      if (!current) return; // A stop/re-ask does not cancel the dispatched job.
      await this.recordStep(current, feature.id, action.step, jobId, action.pr?.number);
    });
  }

  /**
   * US-011: the start of a later feature. Its branch is created outside any transaction, and the
   * flow records it under its locks: a stop, a re-approval or a feature that already started
   * drops the progress. A refusal stops the flow; a transient forge failure waits for the next tick.
   */
  private async advanceStart(pass: DispatchPass<StartFeatureAction>, now: Date): Promise<void> {
    const outcome = await runFeatureStart(this.featurePassDeps(), {
      flow: pass.flow, feature: pass.feature, base: pass.action.base,
    });
    if (outcome.kind === 'stop') {
      await this.writeStop(pass.flow, pass.feature, outcome.reason, outcome.detail, now);
    }
  }

  /** The collaborators the feature passes need; the passes themselves live in their own module. */
  private featurePassDeps(): FeaturePassDeps {
    return {
      steps: this.steps, repos: this.repos, github: this.github,
      activity: this.activity, audit: this.audit, txManager: this.txManager,
      lockLive: (previous) => this.lockLive(previous),
      lockWaitingMerge: (previous) => this.lockWaitingMerge(previous),
      stopLocked: (flow, feature, reason, detail, now) =>
        this.writeDecision(flow, feature, null, { kind: 'stop', reason, detail }, now),
    };
  }

  /** Forge writes never hold locks; their progress belongs to the approval generation that chose them. */
  private async advanceCalls(
    flow: FleetFlowRecord, feature: FleetFlowFeatureRecord, action: ApplyCallsAction,
    plan: FleetJobRecord | null, now: Date,
  ): Promise<void> {
    // The set review covers every spec of the flow: its findings are committed spec by spec.
    if (action.step === 'SPEC_REVIEW') {
      await this.advanceSetCalls(flow, feature, action, now);
      return;
    }
    const expectedHead = plan?.resultSha;
    if (!expectedHead) throw new Error('PRD_REVIEW calls require a PLAN result sha');
    const outcome = await this.calls.apply(flow, action, expectedHead, this.callsTarget(flow, feature));
    if (outcome.kind === 'retry') return;
    if (outcome.kind === 'failed') {
      await this.writeStop(flow, feature, 'calls_failed', `${action.step}: ${outcome.detail}`, now);
      return;
    }
    await this.txManager.run(async () => {
      const current = await this.lockLive(flow);
      if (!current) return;
      if (outcome.kind === 'stale') {
        // A later feature is never re-asked: its spec was checked by its start pass, and a stopped
        // flow is cloned rather than restarted.
        if (isFirstFeature(feature)) {
          await this.flowService.reaskLocked(current, outcome.head, now);
          return;
        }
        await this.writeDecision(current, feature, null, {
          kind: 'stop', reason: 'spec_changed', detail: `${action.step}: spec changed at ${outcome.head}`,
        }, now);
        return;
      }
      // A later feature's calls land on its own branch: they move neither the flow's spec sha nor its set sha.
      const specSha = isFirstFeature(feature) ? outcome.specSha : null;
      await this.steps.recordCalls(current.id, feature.id, action.jobId, specSha);
      await this.record(current, `flow calls ${action.step}`, 'flow.calls', {
        step: action.step, jobId: action.jobId, specSha: outcome.specSha, count: action.findings.length,
      });
    });
  }

  /**
   * The set's `SPEC_REVIEW` findings are committed spec by spec: every feature's own findings go
   * into its own spec, in position order, and each commit lands on the flow branch on top of the
   * previous one. A finding without a feature, or with a name no flow feature has, goes into the
   * set's first spec. The forge calls stay outside the transactions; the markers, the shas and the
   * activity are written once, under the locks, after the last commit.
   */
  private async advanceSetCalls(
    flow: FleetFlowRecord, feature: FleetFlowFeatureRecord, action: ApplyCallsAction, now: Date,
  ): Promise<void> {
    const features = this.orderedFeatures(flow);
    const byId = new Map(features.map((item) => [item.id, item]));
    const commits: { target: FleetFlowFeatureRecord; sha: string }[] = [];
    let head = flow.specSha;
    const replay = { reviewedHead: flow.specSha, paths: features.map((item) => item.specPath) };
    let staleHead: string | null = null;
    for (const group of groupFindingsByFeature(action.findings, features)) {
      const target = byId.get(group.feature.id);
      if (!target) continue;
      const outcome = await this.calls.apply(flow, { ...action, findings: group.findings }, head, {
        feature: target.feature, specPath: target.specPath, branch: flow.branch, replay,
      });
      // A retry writes no progress: the next pass starts again at the first feature, and the replay
      // recovers the specs this pass already committed.
      if (outcome.kind === 'retry') return;
      if (outcome.kind === 'failed') {
        await this.writeStop(flow, feature, 'calls_failed', `${action.step}: ${outcome.detail}`, now);
        return;
      }
      // A stale head ends the pass: the branch moved under the flow.
      if (outcome.kind === 'stale') {
        staleHead = outcome.head;
        break;
      }
      head = outcome.specSha;
      commits.push({ target, sha: outcome.specSha });
    }

    await this.txManager.run(async () => {
      const current = await this.lockLive(flow);
      if (!current) return;
      if (staleHead !== null) {
        // The set review belongs to the flow's first feature: a stale head re-asks the flow.
        if (isFirstFeature(feature)) {
          await this.flowService.reaskLocked(current, staleHead, now);
          return;
        }
        await this.writeDecision(current, feature, null, {
          kind: 'stop', reason: 'spec_changed', detail: `${action.step}: spec changed at ${staleHead}`,
        }, now);
        return;
      }
      const last = commits.at(-1);
      for (const target of this.setCallTargets(features, commits)) {
        if (last !== undefined && target.id === last.target.id) {
          // The last commit is the set's head: it moves the flow's spec sha and its set sha.
          await this.steps.recordCalls(current.id, target.id, action.jobId, last.sha, { setSha: true });
          continue;
        }
        // A marker without a sha: only the last commit moves the flow's shas.
        await this.steps.recordCalls(current.id, target.id, action.jobId, null);
      }
      await this.record(current, `flow calls ${action.step}`, 'flow.calls', {
        step: action.step, jobId: action.jobId, specSha: last?.sha ?? null, count: action.findings.length,
      });
    });
  }

  /**
   * The features whose marker the set pass writes: the set's first feature, which carries the
   * marker the decision reads even when no finding is its own, and every spec the pass committed.
   */
  private setCallTargets(
    features: FleetFlowFeatureRecord[], commits: { target: FleetFlowFeatureRecord; sha: string }[],
  ): FleetFlowFeatureRecord[] {
    const ids = [features[0]?.id, ...commits.map(({ target }) => target.id)];
    const targets: FleetFlowFeatureRecord[] = [];
    for (const id of ids) {
      if (id === undefined || targets.some((target) => target.id === id)) continue;
      const found = features.find((item) => item.id === id);
      if (found) targets.push(found);
    }
    return targets;
  }

  /**
   * The calls target of the feature the step runs for: its spec path and the branch it lives on.
   * The flow's first feature keeps the flow's branch; a later feature brings its own branch.
   */
  private callsTarget(flow: FleetFlowRecord, feature: FleetFlowFeatureRecord): FleetFlowCallsTarget {
    const branch = isFirstFeature(feature) ? flow.branch : (feature.branch ?? flow.branch);
    return { feature: feature.feature, specPath: feature.specPath, branch };
  }

  /**
   * The PRD edits are committed on the flow's branch outside any transaction, exactly like the spec
   * calls: the forge call never holds the flow locks. The marker and the activity are written in a
   * second transaction, under the locks, so a stop or a re-ask that lands in between keeps the commit
   * and drops the progress. The accepted findings are the review's own summary, cut and sanitized:
   * the payload is a JSON column, and a NUL or a lone surrogate would fail the write on every tick.
   */
  private async advancePrdEdits(
    flow: FleetFlowRecord, feature: FleetFlowFeatureRecord, action: ApplyPrdEditsAction,
    plan: FleetJobRecord | null, now: Date,
  ): Promise<void> {
    const expectedHead = plan?.resultSha;
    if (!expectedHead) throw new Error('PRD_REVIEW edits require a PLAN result sha');
    const outcome = await this.calls.applyPrdEdits(flow, action, expectedHead, this.callsTarget(flow, feature));
    if (outcome.kind === 'retry') return;
    if (outcome.kind === 'failed') {
      await this.writeStop(flow, feature, 'calls_failed', `PRD_REVIEW edits: ${outcome.detail}`, now);
      return;
    }
    await this.txManager.run(async () => {
      const current = await this.lockLive(flow);
      if (!current) return;
      if (outcome.kind === 'stale') {
        if (isFirstFeature(feature)) {
          await this.flowService.reaskLocked(current, outcome.head, now);
          return;
        }
        await this.writeDecision(current, feature, null, {
          kind: 'stop', reason: 'spec_changed', detail: `PRD_REVIEW edits: spec changed at ${outcome.head}`,
        }, now);
        return;
      }
      await this.steps.recordPrdEdits(current.id, feature.id, action.jobId);
      await this.record(current, 'flow PRD edits', 'flow.prd_edits', {
        jobId: action.jobId,
        sha: outcome.kind === 'committed' ? outcome.sha : null,
        applied: outcome.kind === 'committed' ? outcome.applied : 0,
        refused: outcome.refused,
        accepted: action.accepted.map((finding) => truncateFlowText(safeFlowJsonText(finding.summary), FLOW_CALL_TEXT_MAX)),
      });
    });
  }

  /**
   * The RULE verdict's rulings leave the decide transaction: every ruling owns its own transaction, so a
   * ruling that cannot be written is a refusal the flow reports, never a failed pass. A ruling for an
   * item the RULE task does not list is refused as well: the task is what the flow may rule.
   */
  private async advanceRulings(
    flow: FleetFlowRecord, feature: FleetFlowFeatureRecord, action: ApplyRulingsAction,
  ): Promise<void> {
    const slug = await this.steps.projectSlug(flow.projectId);
    if (slug === null) {
      // The project is gone: there is nothing left to rule, and no slug to rule it in.
      this.logger.warn(`Flow ${flow.id}: project slug unavailable; the RULE verdict is skipped`);
      return;
    }
    const run = await this.steps.latestJobForStep(flow.id, feature.id, 'RUN');
    const openItems = run?.workflow?.openItems ?? [];
    const ruled = run === null ? [] : await this.rulings.ruledItemIds(run.id);
    // The RULE task lists the RUN's items that are still open and not ruled yet.
    const taskItems = new Set(ruleTaskItems(openItems, ruled).map(({ id }) => id));
    const recorded: string[] = [];
    const refused: { item: string; reason: string }[] = [];
    for (const { item, ruling } of lastRulingPerItem(action.rulings)) {
      if (run === null || !taskItems.has(item)) {
        refused.push({ item: safeItemLabel(item), reason: 'not in task' });
        continue;
      }
      const outcome = await this.rulings.createForFlow({
        projectId: flow.projectId,
        projectSlug: slug,
        runJobId: run.id,
        itemId: item,
        text: ruling,
        creator: { type: flow.createdByType, id: flow.createdById },
        approvalRequestId: flow.approvalRequestId,
        flowId: flow.id,
      });
      if (outcome.kind === 'recorded') recorded.push(safeItemLabel(item));
      else refused.push({ item: safeItemLabel(item), reason: outcome.reason });
    }
    await this.txManager.run(async () => {
      const current = await this.lockLive(flow);
      // A stop that landed while the rulings were written keeps the rulings: they are already committed.
      if (!current) return;
      await this.steps.recordRulings(current.id, feature.id, action.jobId);
      await this.record(current, 'flow rulings', 'flow.rulings', {
        jobId: action.jobId, recorded, refused,
      });
      if (refused.length > 0 && run !== null) {
        const body = `Flow rulings refused (RULE job ${action.jobId}): `
          + refused.map(({ item, reason }) => `${item} (${reason})`).join('; ');
        await this.rulings.commentRefused(run.id, body);
      }
    });
  }

  /**
   * `REVIEW` goes through the review head claim, so an auto-review of the same head is adopted instead of
   * dispatched twice. The claim key is the head the `RUN` pushed (`resultSha`): nothing else writes the
   * feature branch between the `RUN` and this `REVIEW`. Every claim write happens outside a transaction.
   */
  private async advanceReview(pass: DispatchPass<DispatchAction>, now: Date): Promise<void> {
    const { flow, feature, action } = pass;
    const pr = action.pr;
    // The decision engine waits or stops on missing RUN results before selecting REVIEW.
    if (!pr?.headSha) throw new Error('REVIEW requires a RUN result sha');

    const claim = await this.reviews.claimHead(flow.repoId, pr.number, pr.headSha, now);
    // A live pass owns this head but has not linked its job yet: this pass waits rather than duplicate it.
    if (claim.kind === 'busy') return;
    if (claim.kind === 'failed') {
      await this.writeStop(flow, feature, 'dispatch_refused', `REVIEW: ${claim.outcome}`, now);
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
      await this.refuseDispatch(flow, feature, 'REVIEW', error, now);
      return;
    }
    // Link the claim before the record phase: the job exists now, so a record that skips still leaves a
    // head whose claim points at it, and the next pass adopts instead of dispatching again.
    await this.reviews.markDispatched(claim.claimId, jobId);
    await this.txManager.run(async () => {
      const current = await this.lockLive(flow);
      if (!current) return;
      await this.recordStep(current, feature.id, 'REVIEW', jobId, pr.number);
    });
  }

  /**
   * The head already has a job (an auto-review for the same repo, PR and head). Adopt it into this flow in
   * the record transaction, after the flow-state check; a job another flow already owns is a refusal.
   */
  private async adoptReview(pass: DispatchPass<DispatchAction>, jobId: string, now: Date): Promise<void> {
    const { flow, feature, action } = pass;
    await this.txManager.run(async () => {
      const current = await this.lockLive(flow);
      if (!current) return;
      if (!(await this.jobs.adoptForFlow(jobId, current.id, feature.id, 'REVIEW'))) {
        await this.writeDecision(current, feature, null, {
          kind: 'stop', reason: 'dispatch_refused', detail: 'REVIEW: head claimed by another flow',
        }, now);
        return;
      }
      await this.recordStep(current, feature.id, 'REVIEW', jobId, action.pr?.number);
    });
  }

  /** The exact body for the step the decision chose, dispatched for the flow's creator outside a transaction. */
  private async dispatchStep(pass: DispatchPass<DispatchAction>): Promise<string> {
    const { flow, feature, action, plan } = pass;
    const setSpecPaths = action.step === 'SPEC_REVIEW' ? this.setSpecPaths(flow) : undefined;
    const body = buildStepDispatch({
      flow, feature, step: action.step,
      // The set review covers every spec of the flow at once, in position order.
      ...(setSpecPaths !== undefined ? { setSpecPaths } : {}),
      // The dispatch guard supplies the remaining cap; the API config selects the review agent.
      remainingCapUsd: pass.remainingCapUsd, reviewAgent: this.config.flowReviewAgent,
      ...(plan ? { plan } : {}), ...(action.pr ? { pr: action.pr } : {}), ...(pass.rule ? { rule: pass.rule } : {}),
      prdEdits: flow.entry === 'NAX',
    });
    const result = await this.jobs.dispatch(flow.createdById, flow.projectId, body, {
      // US-001: the job belongs to the flow's feature, so a later feature's jobs never answer for it.
      flowId: flow.id, flowStep: action.step, flowFeatureId: feature.id, auditKey: 'system.flow.advance',
    });
    return result.job.id;
  }

  /** The spec paths of the flow's set, in position order; a flow of one spec has no set. */
  private setSpecPaths(flow: FleetFlowRecord): string[] | undefined {
    const features = this.orderedFeatures(flow);
    return features.length > 1 ? features.map(({ specPath }) => specPath) : undefined;
  }

  /** A declared dispatch refusal stops the flow; any other error propagates after the caller released its claim. */
  private async refuseDispatch(
    flow: FleetFlowRecord, feature: FleetFlowFeatureRecord, step: FlowStep, error: unknown, now: Date,
  ): Promise<void> {
    if (!(error instanceof BudgetPausedException || error instanceof ConflictAppException
      || error instanceof ValidationAppException || error instanceof NotFoundAppException
      || error instanceof FleetDispatchException)) throw error;
    const reason = error instanceof BudgetPausedException ? 'budget_paused' : 'dispatch_refused';
    await this.writeStop(flow, feature, reason, `${step}: ${dispatchRefusalReason(error)}`, now);
  }

  /** The write half of a refusal: re-read under the parent/flow locks, then stop with activity and audit. */
  private async writeStop(
    flow: FleetFlowRecord, feature: FleetFlowFeatureRecord, reason: FlowStopReason, detail: string, now: Date,
  ): Promise<void> {
    await this.txManager.run(async () => {
      const current = await this.lockLive(flow);
      if (!current) return;
      await this.writeDecision(current, feature, null, { kind: 'stop', reason, detail }, now);
    });
  }

  /** Recheck the approval generation as well as state: a re-ask may already have been approved again. */
  private async lockLive(previous: FleetFlowRecord): Promise<FleetFlowRecord | null> {
    if (!(await this.lockParent(previous))) return null;
    const current = await this.flows.lockById(previous.id);
    if (!current || (current.state !== 'APPROVED' && current.state !== 'RUNNING')) return null;
    if (current.branch !== previous.branch || current.specSha !== previous.specSha
      || current.approvedAt?.getTime() !== previous.approvedAt?.getTime()) return null;
    return current;
  }

  /**
   * US-012: the merge watch's re-read. The flow must still wait for the same approval: a flow that
   * stopped, was approved again or resumed meanwhile owns nothing of the pass.
   */
  private async lockWaitingMerge(previous: FleetFlowRecord): Promise<FleetFlowRecord | null> {
    if (!(await this.lockParent(previous))) return null;
    const current = await this.flows.lockById(previous.id);
    if (!current || current.state !== 'WAITING_MERGE') return null;
    if (current.approvedAt?.getTime() !== previous.approvedAt?.getTime()) return null;
    return current;
  }

  /** Called only with the parent and flow locked, including crash recovery in the decide transaction. */
  private async recordStep(
    flow: FleetFlowRecord, featureId: string, step: FlowStep, jobId: string, prNumber?: number,
  ): Promise<void> {
    await this.steps.markStep(flow.id, featureId, step, {
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
  private async decide(flow: FleetFlowRecord, now: Date): Promise<DispatchPass | undefined> {
    // The spec preflight belongs to the flow's first feature: once it has run, the flow branch carries
    // its PLAN, RUN and FIX commits, so its head no longer matches `flow.specSha`. A later feature's
    // spec was checked by its start pass.
    const candidate = this.activeFeature(flow);
    // Forge I/O is only a preflight hint. Re-read state/jobs under locks below, and never let a
    // transient forge failure commit even a bookkeeping write. No token crosses this boundary.
    let forgeHead: string | null | undefined;
    if (candidate !== null && isFirstFeature(candidate)) {
      try {
        forgeHead = await this.readSpecHead(flow, now);
      } catch (error) {
        if (error instanceof RepoCheckException) return;
        throw error;
      }
    }

    return this.txManager.run(async () => {
      const parent = await this.lockParent(flow);
      if (!parent) return;
      const current = await this.flows.lockById(flow.id);
      if (!current || (current.state !== 'APPROVED' && current.state !== 'RUNNING')) return;

      // The feature the flow runs now. A flow with no active feature waits for the next-feature
      // transitions: a feature start, a merge wait or the flow's completion.
      const feature = this.activeFeature(current);
      if (!feature) {
        const next = nextFlowFeature(current.features);
        if (next.kind === 'active') return; // the active feature's row is gone: there is nothing to start
        if (next.kind === 'complete') {
          await this.steps.complete(current.id, now);
          await this.record(current, 'flow completed', 'flow.completed', { flowId: current.id, step: null, jobId: null });
          return;
        }
        if (next.kind === 'wait_merge') {
          await this.steps.setFlowState(current.id, 'WAITING_MERGE');
          await this.record(current, 'flow waiting merge', 'flow.waiting_merge', { featureIds: next.featureIds });
          return;
        }
        // A later feature starts on its own branch. The branch is created outside this transaction,
        // so the decision only selects the feature and checks that its creator may still dispatch.
        const starting = this.orderedFeatures(current).find(({ id }) => id === next.featureId);
        if (!starting) return;
        if (!(await this.creatorMayDispatch(current))) {
          await this.writeDecision(current, starting, null, {
            kind: 'stop', reason: 'creator_lost_access', detail: 'flow creator lost dispatch access',
          }, now);
          return;
        }
        return {
          flow: current, feature: starting,
          action: { kind: 'start_feature', featureId: starting.id, base: next.base },
          // Starting a feature spends nothing: the cap is checked before every billed step.
          plan: null, remainingCapUsd: '0.0000',
        };
      }

      const spentUsd = await this.refreshSpent(current);
      // One statement pairs the job with the ingest status of its own lease: a RUN's `resultPrUrl` and
      // that mark commit together, so read apart they could stop a flow whose PR had just been recorded.
      const snapshot = await this.steps.latestJobWithIngest(current.id, feature.id);
      // A dispatch can finish preflight and insert after a different spec was re-approved. queuedAt
      // alone cannot identify that approval's review: ignore the old SHA for both decision and recovery.
      // Our own calls commit is the exception: keep its review only within this approval generation.
      const appliedReview = snapshot !== null && snapshot.job.id === feature.callsJobId
        && current.approvedAt !== null && snapshot.job.queuedAt.getTime() >= current.approvedAt.getTime();
      const latest = snapshot?.job.flowStep === 'SPEC_REVIEW' && snapshot.job.ref !== current.specSha && !appliedReview
        ? null : snapshot;
      const input = await this.decisionInput(current, feature, latest, now);
      const action = decideFlowStep(input);
      // The insert carries the flow link even if dispatch/record crashed. Reconcile once, then let the
      // next tick decide from RUNNING. An older approval's job must never be mistaken for this start.
      const job = latest?.job;
      const recoverable = current.state === 'RUNNING' || (job?.flowStep === 'SPEC_REVIEW'
        && current.approvedAt !== null && job.queuedAt.getTime() >= current.approvedAt.getTime());
      if (job && recoverable && (current.state === 'APPROVED'
        || feature.currentStep !== job.flowStep || feature.state !== 'RUNNING'
        || (job.flowStep === 'REVIEW' && feature.prNumber === null && input.latestJob?.prNumber != null))) {
        await this.recordStep(current, feature.id, job.flowStep as FlowStep, job.id, input.latestJob?.prNumber ?? undefined);
        return;
      }
      if (action.kind !== 'dispatch' && action.kind !== 'apply_calls' && action.kind !== 'apply_rulings'
        && action.kind !== 'apply_prd_edits') {
        await this.writeDecision(current, feature, job ?? null, action, now);
        return;
      }
      // Calls and rulings are not billed. Dispatch guards retain their order; every path checks creator access.
      const remaining = action.kind === 'dispatch' ? remainingCapUsd(current.costCapUsd, spentUsd) : '0.0000';
      if (remaining === null) {
        await this.writeDecision(current, feature, job ?? null, {
          kind: 'stop', reason: 'cost_cap', detail: `spent ${spentUsd} of cap ${current.costCapUsd}`,
        }, now);
        return;
      }
      if (!(await this.creatorMayDispatch(current))) {
        await this.writeDecision(current, feature, job ?? null, {
          kind: 'stop', reason: 'creator_lost_access', detail: 'flow creator lost dispatch access',
        }, now);
        return;
      }
      if (action.kind === 'apply_rulings') {
        // Rulings are written outside this transaction, each in its own: the flow records them after.
        return { flow: current, feature, action, plan: null, remainingCapUsd: remaining };
      }
      if (action.kind === 'apply_calls' || action.kind === 'apply_prd_edits') {
        // The PRD edit action has no step of its own: it belongs to the PRD_REVIEW branch.
        const prdReview = action.kind === 'apply_prd_edits' || action.step === 'PRD_REVIEW';
        const plan = prdReview ? await this.steps.latestJobForStep(current.id, feature.id, 'PLAN') : null;
        if (prdReview) {
          if (!plan?.resultBranch || !plan.resultSha) throw new Error('PRD_REVIEW calls require a PLAN result branch and sha');
          if (isFirstFeature(feature)) {
            // PLAN pushes to the PRD's branchName, not necessarily the accepted input branch. Persist
            // its target under the locks so calls, re-asks and the following PLAN all use that branch.
            if (current.branch !== plan.resultBranch) {
              await this.steps.setBranch(current.id, plan.resultBranch);
              await this.record(current, 'flow PLAN output branch', 'flow.branch', { branch: plan.resultBranch, jobId: plan.id });
              current.branch = plan.resultBranch;
            }
          } else {
            // A later feature plans on its own branch: a PLAN that pushed elsewhere is a refusal.
            const expected = feature.branch ?? current.branch;
            if (plan.resultBranch !== expected) {
              await this.writeDecision(current, feature, job ?? null, {
                kind: 'stop', reason: 'dispatch_refused', detail: `PLAN pushed ${plan.resultBranch}, expected ${expected}`,
              }, now);
              return;
            }
          }
        }
        return { flow: current, feature, action, plan, remainingCapUsd: remaining };
      }
      if (isFirstFeature(feature) && (action.step === 'SPEC_REVIEW' || action.step === 'PLAN')) {
        // A different approval/target or a newly eligible step needs its own preflight next pass.
        // In particular, never re-ask a freshly approved spec using an older generation's head.
        if (current.threadId === null && (forgeHead === undefined
          || current.repoId !== flow.repoId || current.branch !== flow.branch || current.specSha !== flow.specSha
          || current.approvedAt?.getTime() !== flow.approvedAt?.getTime())) return;
        if (current.threadId === null && forgeHead === null) {
          await this.writeDecision(current, feature, job ?? null, {
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
        ? await this.steps.latestJobForStep(current.id, feature.id, 'PLAN') : null;
      let rule: DispatchPass['rule'];
      if (action.step === 'RULE') {
        const run = await this.steps.latestJobForStep(current.id, feature.id, 'RUN');
        if (!run?.resultBranch) {
          await this.writeDecision(current, feature, job ?? null, {
            kind: 'stop', reason: 'dispatch_refused', detail: 'RULE: RUN has no result branch',
          }, now);
          return;
        }
        const workflow = run.workflow;
        const ruled = workflow === null ? [] : await this.rulings.ruledItemIds(run.id);
        if (feature.prNumber === null) {
          await this.writeDecision(current, feature, job ?? null, {
            kind: 'stop', reason: 'dispatch_refused', detail: 'RULE: feature has no PR number',
          }, now);
          return;
        }
        const answeredId = action.rule?.answeredJobId ?? null;
        const answeredJob = answeredId !== null && latest?.job.id === answeredId ? latest.job : null;
        const guidance: FlowRuleGuidance | null = answeredId === null ? null : {
          held: answeredJob?.flowStep === 'FIX' ? answeredJob.fixReady?.readyHeld ?? null : null,
          questions: (feature.questions ?? []) as FlowQuestion[],
          answers: (feature.answers ?? []) as FlowAnswer[],
        };
        rule = {
          ref: run.resultBranch,
          prNumber: feature.prNumber,
          items: ruleTaskItems((workflow?.openItems ?? []) as FlowOpenItem[], ruled),
          guidance,
        };
      }
      return { flow: current, feature, action, plan, remainingCapUsd: remaining, ...(rule ? { rule } : {}) };
    });
  }

  /**
   * The feature the flow runs now, or null when it has none: `nextFlowFeature` picks the running
   * feature, else the first pending one, else answers that the flow waits for a merge or completes.
   */
  private activeFeature(flow: FleetFlowRecord): FleetFlowFeatureRecord | null {
    const action = nextFlowFeature(flow.features);
    if (action.kind !== 'active') return null;
    return this.orderedFeatures(flow).find(({ id }) => id === action.featureId) ?? null;
  }

  /** The features of the flow in position order: the position is the run order, not the row order. */
  private orderedFeatures(flow: FleetFlowRecord): FleetFlowFeatureRecord[] {
    return [...flow.features].sort((left, right) => left.position - right.position);
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
  private async readSpecHead(flow: FleetFlowRecord, now: Date): Promise<string | null | undefined> {
    if (flow.threadId !== null || (flow.state !== 'APPROVED' && flow.state !== 'RUNNING')) return;
    const first = this.orderedFeatures(flow)[0];
    if (!first) return;
    const snapshot = await this.steps.latestJobWithIngest(flow.id, first.id);
    const latest = snapshot?.job;
    // Calls own forge failure classification, including permanent installation failures. A dispatch
    // preflight here would swallow them before the transactional calls_failed stop/outbox path.
    // The locked decision still re-reads everything; an action that changes to dispatch waits a tick.
    if (latest?.flowStep === 'SPEC_REVIEW' && latest.ref === flow.specSha
      && decideFlowStep(await this.decisionInput(flow, first, snapshot, now)).kind === 'apply_calls') return;
    if (flow.state !== 'APPROVED' && latest
      && !(isTerminal(latest.state) && (latest.flowStep === 'SPEC_REVIEW'
        || (latest.flowStep === 'PRD_REVIEW' && latest.id === first.callsJobId)))) return;
    const repo = await this.repos.findReviewRepo(flow.repoId);
    if (!repo || repo.githubInstallationId === null) return null;
    const { token } = await this.github.mintReadOnlyToken(repo.githubInstallationId, repo.name);
    return this.github.getBranchHead(token, repo.owner, repo.name, flow.branch);
  }

  /**
   * The flow's creator must still be allowed to dispatch: a creator that lost its access stops the
   * flow before anything is spent or created on the forge.
   */
  private async creatorMayDispatch(flow: FleetFlowRecord): Promise<boolean> {
    const creatorRef: PrincipalRef = { type: flow.createdByType, id: flow.createdById };
    const access = await this.steps.creatorAccess(creatorRef);
    const keys = await this.permissions.effectiveKeys(creatorRef, { projectId: flow.projectId });
    return mayDispatch(access, keys);
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

  private async decisionInput(
    flow: FleetFlowRecord, feature: FleetFlowFeatureRecord, latest: LatestFlowJob | null, now: Date,
  ): Promise<FlowStepInput> {
    const latestJob = latest === null ? null : await this.jobView(flow, latest.job);
    const needsRuleInputs = latestJob?.step === 'REVIEW' || latestJob?.step === 'RULE';
    const run = needsRuleInputs ? await this.steps.latestJobForStep(flow.id, feature.id, 'RUN') : null;
    const workflow = run?.workflow ?? null;
    const ruledItemIds = workflow === null ? [] : await this.rulings.ruledItemIds(run.id);
    const specReviewCount = latestJob?.step === 'SPEC_REVIEW'
      ? await this.steps.countJobsForStepSince(flow.id, feature.id, 'SPEC_REVIEW', flow.approvedAt ?? now)
      : undefined;
    return {
      state: flow.state,
      // The flow's first feature is the one at position 0; every later feature starts at its PLAN.
      firstFeature: isFirstFeature(feature),
      // An APPROVED or RUNNING flow was approved before it became live; the fallback only widens the type.
      approvedAt: flow.approvedAt ?? now,
      latestJob,
      ...(needsRuleInputs ? {
        run: workflow === null ? null : { outcome: workflow.outcome, openItems: workflow.openItems as FlowOpenItem[] },
        ruledItemIds,
        rulingsJobId: feature.rulingsJobId ?? null,
      } : {}),
      now,
      prWaitMs: this.config.flowPrWaitMs,
      // Only a finished RUN consults this, and it arrives with the row it belongs to.
      ingestSettled: latest?.ingestSettled ?? false,
      featurePrNumber: feature.prNumber ?? null,
      callsJobId: feature.callsJobId ?? null,
      planCount: await this.steps.countJobsForStepSince(flow.id, feature.id, 'PLAN', flow.approvedAt ?? now),
      ...(specReviewCount !== undefined ? { specReviewCount } : {}),
      prdEditsJobId: feature.prdEditsJobId ?? null,
      canApplyCalls: flow.entry === 'NAX',
      questionsJobId: feature.questionsJobId ?? null,
      answers: feature.answers ?? null,
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
    // REVIEW inserts already carry the canonical PR feature, even if the record phase never committed.
    if (job.flowStep === 'REVIEW') return prNumberOfReviewFeature(job.feature);
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
    feature: FleetFlowFeatureRecord,
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
      await this.outbox.record({
        type: FLEET_FLOW_STOPPED,
        payload: {
          flowId: flow.id, projectId: flow.projectId, feature: feature.feature,
          stopReason: action.reason, detail: detail.slice(0, 500), approverId: flow.approverId,
          creatorType: flow.createdByType, creatorId: flow.createdById,
        },
        metadata: { projectId: flow.projectId, eventId: `${flow.id}:stopped` },
      });
      return;
    }
    if (action.kind === 'wait_answer') {
      await this.steps.setWaiting(flow.id, feature.id, { jobId: action.jobId, questions: action.questions });
      await this.audit.record({
        key: 'system.flow.advance', resourceType: 'flow', resourceId: flow.id, projectId: flow.projectId,
        summary: `flow waiting answer ${action.step}`,
      });
      await this.activity.record({
        actorType: 'SYSTEM', actorId: 'flow', action: 'flow.waiting', entityType: 'flow', entityId: flow.id,
        projectId: flow.projectId, payload: { step: action.step, jobId: action.jobId, count: action.questions.length },
      });
      await this.outbox.record({
        type: FLEET_FLOW_QUESTIONS,
        payload: {
          flowId: flow.id, projectId: flow.projectId, feature: feature.feature, step: action.step,
          jobId: action.jobId, questions: action.questions, approverId: flow.approverId,
          creatorType: flow.createdByType, creatorId: flow.createdById,
        },
        metadata: { projectId: flow.projectId, eventId: `${flow.id}:questions:${action.jobId}` },
      });
      return;
    }
    if (action.kind === 'complete') {
      // A ready FIX completes this feature, not necessarily the flow. Evaluate against the updated
      // in-memory view so the just-finished feature cannot be selected again from the locked snapshot.
      await this.steps.markFeatureState(feature.id, 'READY');
      await this.record(flow, 'flow feature ready', 'flow.feature_ready', {
        feature: feature.feature, featureId: feature.id, prNumber: feature.prNumber,
      });
      const updated = flow.features.map((item) => item.id === feature.id ? { ...item, state: 'READY' } : item);
      const next = nextFlowFeature(updated);
      if (next.kind === 'complete') {
        await this.steps.complete(flow.id, now);
        await this.record(flow, 'flow completed', 'flow.completed', {
          flowId: flow.id, step: job?.flowStep ?? null, jobId: job?.id ?? null,
        });
      } else if (next.kind === 'wait_merge') {
        await this.steps.setFlowState(flow.id, 'WAITING_MERGE');
        await this.record(flow, 'flow waiting merge', 'flow.waiting_merge', { featureIds: next.featureIds });
      }
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

/**
 * A verdict item id is untrusted text: it is written into the activity's JSONB payload and into a
 * ticket comment, and PostgreSQL rejects a NUL and an unpaired surrogate in both. The raw id still
 * decides whether the ruling is in the task and which item it rules; only the display is sanitized.
 */
function safeItemLabel(item: string): string {
  return oneLine(safeFlowJsonText(item));
}

/**
 * The flow's first feature is the one at position 0 (US-008): it keeps the flow's branch and owns
 * the set's `SPEC_REVIEW`. Every later feature runs on its own branch and starts at its `PLAN`.
 */
function isFirstFeature(feature: FleetFlowFeatureRecord): boolean {
  return feature.position === 0;
}

/**
 * The verdict may rule one item twice: the last ruling of an item wins, and the rulings that are kept
 * stay in the order of the verdict. A `Map` keeps the position of a key it already holds, so the
 * earlier ruling is deleted before the later one is set.
 */
function lastRulingPerItem(rulings: FlowRuling[]): FlowRuling[] {
  const latest = new Map<string, FlowRuling>();
  for (const ruling of rulings) {
    latest.delete(ruling.item);
    latest.set(ruling.item, ruling);
  }
  return [...latest.values()];
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

import { Inject, Injectable } from '@nestjs/common';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { currentContext } from '../../../action-context/action-context';
import type { ApprovalCommand } from '../../../approvals/approval-command.registry';
import { AuditRecorder } from '../../../audit/audit-recorder.service';
import { committedEffect } from '../../../common/committed-effects';
import { ConflictAppException } from '../../../common/exceptions/conflict-app.exception';
import { BudgetsService } from '../../budgets/budgets.service';
import { BUDGET_REPOSITORY, type IBudgetRepository } from '../../budgets/domain/budget.domain';
import { MAX_BUDGET_USD } from '../../budgets/dto/create-budget-policy.dto';
import { FleetJobsService } from '../../jobs/fleet-jobs.service';
import { ApprovalCloser, userActor } from '../approval-closer';
import { ApprovalLivePublisher } from '../approval-live.publisher';
import { MAX_REQUEUE_CANDIDATES, type RequeueCandidate } from '../domain/approval.domain';
import { FleetApprovalAskStore } from '../fleet-approval-ask.store';
import { budgetRouteOf, errorText } from '../fleet-ask-helpers';

/**
 * Permissions P3 US-005: the frozen input of a budget ask. A paused policy's ask records the window it
 * stopped in, and `requestedAt` is when it opened — the re-queue candidates are the jobs cancelled for
 * the policy from then on, so the frozen input is what says where that window starts.
 */
export interface BudgetAskInput {
  policyId: string;
  scopeType: string;
  scopeId: string | null;
  windowKind: string;
  windowStart: string;
  spentUsd: string;
  amountUsd: string;
  requestedAt: string;
}
/** The decider's raise: the new cap and the cancelled jobs to put back in the queue. */
export interface BudgetDecision { amountUsd: number; requeueJobIds: string[] }
/** `requeue` is the raw candidate rows, kept for the post-commit re-queues; `toResult` never exposes them. */
export interface BudgetResult { resumedAmountUsd: string; requeue: RequeueCandidate[]; refused: string[] }

interface RequeueResult { jobId: string; ok: boolean; error?: string }

/** What `execute` records for an id the decision named that is no longer a candidate. */
const REFUSED_REASON = 'not a re-queue candidate';
/** `JobSchedule`-style ids are short; a longer string is a client bug, not a job. */
const MAX_REQUEUE_ID_LENGTH = 64;

/**
 * Permissions P3 US-005: approving a budget ask raises the policy and resumes it, then re-queues the
 * cancelled jobs the decider named. Registration lives in `ApprovalsModule.onModuleInit`.
 *
 * The supersede step (closing the policy's other pending ask) belongs to US-007, once the engine owns
 * `closeForPolicy`; `closer` and `live` are injected now so that story adds no constructor argument.
 */
@Injectable()
export class FleetBudgetOverrideCommand implements ApprovalCommand<BudgetAskInput, BudgetResult, BudgetDecision> {
  readonly key = 'fleet.budget.override';

  constructor(
    @Inject(BUDGET_REPOSITORY) private readonly policies: Pick<IBudgetRepository, 'lockById'>,
    private readonly budgets: BudgetsService,
    private readonly jobs: FleetJobsService,
    private readonly asks: FleetApprovalAskStore,
    private readonly closer: ApprovalCloser,
    private readonly live: ApprovalLivePublisher,
    private readonly audit: AuditRecorder,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  parse(input: unknown): BudgetAskInput {
    if (!isRecord(input) || !isText(input.policyId) || !isText(input.scopeType) || !isText(input.windowKind) ||
        !isDateText(input.windowStart) || !isText(input.spentUsd) || !isText(input.amountUsd) || !isDateText(input.requestedAt) ||
        !isNullableText(input.scopeId)) {
      throw new Error('invalid budget ask input');
    }
    return {
      policyId: input.policyId, scopeType: input.scopeType, scopeId: input.scopeId,
      windowKind: input.windowKind, windowStart: input.windowStart, spentUsd: input.spentUsd,
      amountUsd: input.amountUsd, requestedAt: input.requestedAt,
    };
  }

  /**
   * A raise needs an amount; the re-queue ids are optional and are a set, so a repeated id must not
   * re-queue twice (and record a failure for a job that in fact succeeded).
   */
  parseDecision(decision: 'approve' | 'reject', params: unknown, input: BudgetAskInput): BudgetDecision {
    if (decision === 'reject') {
      if (params !== undefined) throw new Error('invalid budget rejection');
      return undefined;
    }
    if (!isRecord(params) || !isRaiseAmount(params.amountUsd)) throw new Error('invalid budget approval');
    return { amountUsd: params.amountUsd, requeueJobIds: requeueIds(params.requeueJobIds) };
  }

  async execute(input: BudgetAskInput, decision?: BudgetDecision): Promise<BudgetResult> {
    const { requestId, approverId } = approvalOf();
    if (!decision) throw new Error('budget approval decision is required');
    const now = new Date();
    // The engine holds the request first; the policy is second (lock order, spec §1.4).
    const policy = await this.policies.lockById(input.policyId);
    // Deleted between the ask and this decide: the ask is moot, and the transaction rolls back.
    if (!policy) throw new ConflictAppException({}, 'fleet.approvalNotPending');

    const candidates = await this.asks.findRequeueCandidates(policy.id, new Date(input.requestedAt), MAX_REQUEUE_CANDIDATES);
    const byId = new Map(candidates.map((candidate) => [candidate.jobId, candidate]));
    const requeue: RequeueCandidate[] = [];
    const refused: string[] = [];
    for (const jobId of decision.requeueJobIds) {
      const candidate = byId.get(jobId);
      if (candidate) requeue.push(candidate);
      else refused.push(jobId);
    }

    // Joins this transaction: a policy that is no longer paused, or a raise at or below the window's
    // spend, throws here and the engine settles the request `failed`.
    const resumed = await this.budgets.resume(approverId, budgetRouteOf(policy), policy.id, decision.amountUsd, now, { approvalId: requestId });
    const resumedAmountUsd = resumed.amountUsd;
    // Permissions P3 US-007: a hard stop that landed while this approve was executing opened a newer ask (its close
    // of the executing request was skipped by the lock rule). The raise answers the policy, so that ask is moot.
    // The executing request is `approved` by now, so it is never the one closed.
    const closed = await this.closer.closeForPolicy(policy.id, {
      status: 'cancelled', resolvedBy: 'superseded', actor: userActor(approverId),
    }, now);
    committedEffect(() => this.live.publish(closed.live));
    await this.asks.setOutcome(requestId, { resumedAmountUsd, requeueResults: refusedResults(refused) });
    await this.audit.record({
      key: this.key, resourceType: 'fleet-approval', resourceId: requestId, projectId: policy.projectId,
      summary: `raised to ${resumedAmountUsd} and resumed`,
    });
    return { resumedAmountUsd, requeue, refused };
  }

  /** Plan D232: each re-queue is its own transaction, so one failure cannot undo the resume or the rest. */
  async afterCommit(input: BudgetAskInput, decision: BudgetDecision | undefined, result: BudgetResult): Promise<void> {
    const { requestId, approverId } = approvalOf();
    const results: RequeueResult[] = [];
    for (const candidate of result.requeue) {
      try {
        await this.jobs.requeue(approverId, candidate.projectId, candidate.jobId);
        results.push({ jobId: candidate.jobId, ok: true });
      } catch (error) {
        results.push({ jobId: candidate.jobId, ok: false, error: errorText(error) });
      }
    }

    const refusedEntries = refusedResults(result.refused);
    await this.txManager.run(async () => {
      const link = await this.asks.findByRequest(requestId);
      await this.asks.setOutcome(requestId, { ...(link?.outcome ?? {}), requeueResults: [...refusedEntries, ...results] });
    });
  }

  /** The request stores the new cap only: the candidate rows are an execution detail. */
  toResult(result: BudgetResult): { resumedAmountUsd: string } {
    return { resumedAmountUsd: result.resumedAmountUsd };
  }
}

/** The request and the approver are the engine's, not the command's: a command run outside it throws. */
function approvalOf(): { requestId: string; approverId: string } {
  const approval = currentContext()?.approval;
  if (!approval?.requestId || !approval?.approverId) throw new Error('fleet budget ask needs its request and approver ids');
  return { requestId: approval.requestId, approverId: approval.approverId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** `scopeId` is absent for a global policy and a string for every other scope. */
function isNullableText(value: unknown): value is string | null {
  return value === null || isText(value);
}

/** An ISO date the query can use: `execute` builds a `Date` from it. */
function isDateText(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(new Date(value).getTime());
}

/** DTO parity (`decide-approval.dto.ts`): a finite amount above zero, at most `MAX_BUDGET_USD`, 4 dp. */
function isRaiseAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_BUDGET_USD &&
    Number(value.toFixed(4)) === value;
}

/** Absent: no re-queue. Otherwise at most the candidate cap, and the ids are de-duplicated in order. */
function requeueIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_REQUEUE_CANDIDATES) throw new Error('invalid budget approval re-queue ids');
  const seen = new Set<string>();
  for (const jobId of value) {
    if (typeof jobId !== 'string' || jobId.length === 0 || jobId.length > MAX_REQUEUE_ID_LENGTH) {
      throw new Error('invalid budget approval re-queue id');
    }
    seen.add(jobId);
  }
  return [...seen];
}

/** Plan A9: an id the decision named that is not a candidate is reported, never silently dropped. */
function refusedResults(jobIds: readonly string[]): RequeueResult[] {
  return jobIds.map((jobId) => ({ jobId, ok: false, error: REFUSED_REASON }));
}

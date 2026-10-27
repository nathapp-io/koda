import { Injectable } from '@nestjs/common';
import { ForbiddenAppException, NotFoundAppException, ValidationAppException, type IPageOption } from '@nathapp/nestjs-common';
import { IPageResult } from '@nathapp/nestjs-data';
import { remapPage } from '../../common/dto/koda-page.query';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { isAgentPrincipal, type KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { ApprovalDecisionService } from '../../approvals/approval-decision.service';
import { decideEligibility } from '../../approvals/approval-eligibility';
import { ApprovalRequestQueries } from '../../approvals/approval-request.queries';
import type { ApprovalRequestRecord, EligibilityRefusal } from '../../approvals/domain/approval.domain';
import {
  ApprovalDecisionParamsInvalidError, ApprovalDecideForbiddenError, ApprovalRequestExpiredError, ApprovalRequestNotPendingError,
} from '../../approvals/domain/approval.errors';
import { PermissionService } from '../../permissions/permission.service';
import { BudgetsService } from '../budgets/budgets.service';
import { ApprovalCloser, userActor } from './approval-closer';
import { ApprovalLivePublisher } from './approval-live.publisher';
import { checkBashDecision } from './bash-decision';
import {
  ApprovalStatus, ApprovalType, FleetApprovalRecord, MAX_REQUEUE_CANDIDATES, RequeueCandidate,
} from './domain/approval.domain';
import { ApprovalCountsDto } from './dto/approval-counts.dto';
import type { DecideApprovalDto } from './dto/decide-approval.dto';
import { FleetApprovalDto } from './dto/fleet-approval.dto';
import { FleetApprovalAskStore } from './fleet-approval-ask.store';

/** Which prefix a request came through (plan D230). Permissions P1 US-004: the project variant carries the project's id only. */
export type ApprovalRoute = { kind: 'admin' } | { kind: 'project'; projectId: string };
export interface ApprovalCaller { id: string }

/** The principal deciding, as the engine names it. */
type Decider = { type: 'USER' | 'AGENT'; id: string };

/** The engine's decision and params for one fleet decision; `undefined` params mean "none". */
interface EngineDecide { decision: 'approve' | 'reject'; params?: unknown }

function invalid(reason: string): never {
  throw new ValidationAppException({ reason }, 'fleet.approvalDecisionInvalid');
}

const visible = (route: ApprovalRoute, a: FleetApprovalRecord): boolean => route.kind === 'admin' || a.projectId === route.projectId;

/**
 * S1.5 §2.3: list, get, decide and count approvals — the fleet adapters over the P3 approval engine.
 *
 * Permissions P3 US-007 (fix round 1): every read and the decide path run on `ApprovalRequest` + `FleetApprovalAsk`
 * (`FleetApprovalAskStore`) and `ApprovalDecisionService`, so the list, the detail page and the decide route serve the
 * asks the evaluator, the relay and the scheduler open. The fleet keeps its own vocabulary: `FleetApprovalDto`, the
 * `fleet.approvals` / `fleet.approvalNotPending` / `fleet.approvalDecisionInvalid` / `fleet.budgetNotPaused` errors and
 * its decision names, mapped onto the engine's `approve`/`reject` and the command's params.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly store: FleetApprovalAskStore,
    private readonly queries: ApprovalRequestQueries,
    private readonly decisions: ApprovalDecisionService,
    private readonly budgets: BudgetsService,
    private readonly permissions: PermissionService,
    private readonly closer: ApprovalCloser,
    private readonly live: ApprovalLivePublisher,
  ) {}

  async list(route: ApprovalRoute, q: { status?: ApprovalStatus; type?: ApprovalType; jobId?: string }, page: IPageOption): Promise<IPageResult<FleetApprovalDto>> {
    const projectId = route.kind === 'project' ? route.projectId : undefined;
    return remapPage(await this.store.findPage({ ...q, ...(projectId !== undefined ? { projectId } : {}) }, page), (a) => FleetApprovalDto.from(a));
  }

  async get(route: ApprovalRoute, id: string): Promise<FleetApprovalDto> {
    const approval = await this.findVisible(route, id);
    if (approval.type !== 'budget_override_required' || approval.status !== 'pending' || !approval.policyId) return FleetApprovalDto.from(approval);
    return FleetApprovalDto.from(approval, await this.candidates(approval.policyId, approval.requestedAt));
  }

  /**
   * Spec §2.3 as the fleet adapter: what the caller may decide is answered before what they sent, then the fleet's
   * decision is translated into the engine's and run through `ApprovalDecisionService`, and the reloaded view is what
   * the caller reads back.
   */
  async decide(caller: ApprovalCaller & { principal: KodaPrincipal }, route: ApprovalRoute, id: string, dto: DecideApprovalDto, now = new Date()): Promise<FleetApprovalDto> {
    // Step 1: the row exists and this route may see it. Step 2: only a pending ask can be decided.
    const current = await this.findVisible(route, id);
    if (current.status !== 'pending') throw new ConflictAppException({}, 'fleet.approvalNotPending');
    const request = await this.queries.findById(id);
    if (request === null) throw new NotFoundAppException({}, 'fleet.approvals');
    // Step 3: eligibility before validation, so a caller who may not decide is refused whatever the body says.
    const decider: Decider = { type: isAgentPrincipal(caller.principal) ? 'AGENT' : 'USER', id: caller.id };
    const keys = await this.permissions.effectiveKeys(decider, request.projectId ? { projectId: request.projectId } : 'global');
    const eligibility = decideEligibility(request, decider, keys);
    if (eligibility.ok === false) throw refusalOf(eligibility.reason, request, decider);

    const engine = await this.engineDecision(current, dto, now);
    try {
      await this.decisions.decide(id, engine.decision, dto.comment ?? null, now, engine.params);
    } catch (error) {
      throw decideFailure(error, request, decider);
    }
    const view = await this.store.findApproval(id);
    if (view === null) throw new NotFoundAppException({}, 'fleet.approvals');
    // Step 7: an answer that found the job ended closes the link `job_ended` without answering nax.
    if (view.type === 'nax_bash_escalate' && view.resolvedBy === 'job_ended') throw new ConflictAppException({}, 'fleet.approvalNotPending');
    // The fleet's own outputs of a decision (activity row, `fleet.approval.resolved` webhook, live event) stay here
    // until the engine's `FleetAskEventsSubscriber` records them from the outbox (permissions P3 US-009, which owns
    // the `recordedStatus` idempotency key); the decision itself has already committed.
    this.live.publish(await this.closer.recordResolved(view, userActor(caller.id)));
    return FleetApprovalDto.from(view);
  }

  /**
   * US-006: the badge counts what the caller may read. `{ all: true }` is a global `fleet.approval.read`
   * grant (every live project, plus the asks with no project); otherwise only the projects where the
   * caller holds that key are counted, and nothing is unscoped.
   *
   * Narrowed with `in`, not `scope.all`: the API compiles with `strictNullChecks: false`, where `false`
   * is not a literal type and the truthiness check does not discriminate the union.
   */
  async counts(scope: { all: true } | { all: false; projectIds: string[] }): Promise<ApprovalCountsDto> {
    const projects = 'projectIds' in scope ? await this.store.countPending(scope.projectIds) : await this.store.countPendingAllProjects();
    const unscoped = 'projectIds' in scope ? 0 : await this.store.countPendingUnscoped();
    return Object.assign(new ApprovalCountsDto(), {
      total: projects.reduce((sum, p) => sum + p.pending, unscoped), unscoped, projects,
    });
  }

  /**
   * Steps 4 and 5: the fleet decision as the engine's decision and the command's params. The offer rules (an option
   * nax did not offer, a truncated command, a re-queue id that is not a candidate, a paused raise that is not above
   * the window's spend) are checked here, while the request is still pending, so the caller keeps today's 400/409.
   */
  private async engineDecision(view: FleetApprovalRecord, dto: DecideApprovalDto, now: Date): Promise<EngineDecide> {
    if (view.type === 'nax_bash_escalate') {
      if (dto.amountUsd !== undefined || dto.requeueJobIds !== undefined) {
        throw new ValidationAppException({ reason: 'amountUsd and requeueJobIds apply only to budget approvals' }, 'fleet.approvalInput');   // plan D287
      }
      const checked = checkBashDecision(view.payload, dto.decision);
      // strictNullChecks is off: `in` narrows, `.ok` does not.
      if ('reason' in checked) invalid(checked.reason);
      return checked.choice === 'deny' ? { decision: 'reject' } : { decision: 'approve', params: { choice: checked.choice } };
    }

    if (dto.decision !== 'keep_paused' && dto.decision !== 'raise_budget_and_resume') invalid(`${dto.decision} does not apply to a budget approval`);
    if (dto.decision === 'keep_paused') return { decision: 'reject' };
    const policyId = view.policyId;
    if (!policyId) invalid('a budget approval with no policy cannot be decided'); // plan D236
    if (dto.amountUsd === undefined) invalid('amountUsd is required to raise and resume');
    const offered = new Set((await this.store.findRequeueCandidates(policyId, view.requestedAt, MAX_REQUEUE_CANDIDATES)).map((c) => c.jobId));
    // A subset is a set (spec §1.5): a repeated id would re-queue twice and record `{ok:false}` for a job that succeeded.
    const requeueJobIds = [...new Set(dto.requeueJobIds ?? [])];
    for (const jobId of requeueJobIds) if (!offered.has(jobId)) invalid(`job ${jobId} is not a re-queue candidate`);
    await this.budgets.assertResumable(policyId, dto.amountUsd, now);
    return { decision: 'approve', params: { amountUsd: dto.amountUsd, requeueJobIds } };
  }

  private async findVisible(route: ApprovalRoute, id: string): Promise<FleetApprovalRecord> {
    const approval = await this.store.findApproval(id);
    if (!approval || !visible(route, approval)) throw new NotFoundAppException({}, 'fleet.approvals');
    return approval;
  }

  private async candidates(policyId: string, since: Date): Promise<{ rows: RequeueCandidate[]; truncated: boolean }> {
    const rows = await this.store.findRequeueCandidates(policyId, since, MAX_REQUEUE_CANDIDATES + 1);
    return { rows: rows.slice(0, MAX_REQUEUE_CANDIDATES), truncated: rows.length > MAX_REQUEUE_CANDIDATES };
  }
}

/** The ask's own agent, refused for contributing only `self`: the engine's `tier-too-low` rides on this error. */
function refusalOf(reason: EligibilityRefusal, request: ApprovalRequestRecord, decider: Decider): ForbiddenAppException {
  const onBehalfOf = request.onBehalfOf;
  const self = onBehalfOf !== null && onBehalfOf.type === 'AGENT' && decider.type === 'AGENT' && onBehalfOf.id === decider.id;
  return reason === 'tier-too-low' && self
    ? new ForbiddenAppException({}, 'fleet.approvalSelfDecide')
    : new ForbiddenAppException({}, 'permissions');
}

/**
 * The engine's refusals as the fleet's errors: a request that is no longer pending (or has expired) is the fleet's
 * 409, a decided refusal is the same 403 the pre-check answers, and refused params are the fleet's 400.
 */
function decideFailure(error: unknown, request: ApprovalRequestRecord, decider: Decider): never {
  if (error instanceof ApprovalRequestNotPendingError || error instanceof ApprovalRequestExpiredError) {
    throw new ConflictAppException({}, 'fleet.approvalNotPending');
  }
  if (error instanceof ApprovalDecideForbiddenError) throw refusalOf(error.reason, request, decider);
  if (error instanceof ApprovalDecisionParamsInvalidError) invalid(`the engine refused the decision params: ${error.reason}`);
  throw error;
}

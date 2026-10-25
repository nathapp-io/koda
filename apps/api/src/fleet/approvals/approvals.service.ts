import { Inject, Injectable } from '@nestjs/common';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { AppException, ForbiddenAppException, NotFoundAppException, ValidationAppException, type IPageOption } from '@nathapp/nestjs-common';
import { IPageResult, ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { remapPage } from '../../common/dto/koda-page.query';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FleetCommandType } from '../../common/enums';
import type { LiveFleetApprovalEvent } from '../../live/live-event';
import { isAgentPrincipal, type KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { PermissionService } from '../../permissions/permission.service';
import { BudgetRoute, BudgetsService } from '../budgets/budgets.service';
import { BUDGET_REPOSITORY, BudgetPolicyRecord, IBudgetRepository } from '../budgets/domain/budget.domain';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { RunnerNotifier } from '../jobs/runner-notifier';
import { FleetJobsService } from '../jobs/fleet-jobs.service';
import { ApprovalCloser, jobSystemActor, userActor } from './approval-closer';
import { ApprovalLivePublisher } from './approval-live.publisher';
import { AssistantActionPort } from './assistant-action.port';
import { checkBashDecision } from './bash-decision';
import {
  APPROVAL_REPOSITORY, ApprovalStatus, ApprovalType, FleetApprovalRecord, IApprovalRepository, MAX_REQUEUE_CANDIDATES, RequeueCandidate,
} from './domain/approval.domain';
import { ApprovalCountsDto } from './dto/approval-counts.dto';
import type { DecideApprovalDto } from './dto/decide-approval.dto';
import { FleetApprovalDto } from './dto/fleet-approval.dto';

/** Which prefix a request came through (plan D230). Permissions P1 US-004: the project variant carries the project's id only. */
export type ApprovalRoute = { kind: 'admin' } | { kind: 'project'; projectId: string };
export interface ApprovalCaller { id: string }

/** The decide key of each approval type (permissions P1d US-006): the type, never the route, chooses it. */
const DECIDE_KEYS = {
  nax_bash_escalate: 'fleet.approval.decide.bash',
  budget_override_required: 'fleet.approval.decide.budget',
} as const;

interface RequeueResult { jobId: string; ok: boolean; error?: string }

function invalid(reason: string): never {
  throw new ValidationAppException({ reason }, 'fleet.approvalDecisionInvalid');
}

const visible = (route: ApprovalRoute, a: FleetApprovalRecord): boolean => route.kind === 'admin' || a.projectId === route.projectId;

/** Plan D229: the budgets service's ownership route follows the policy's scope, not the request prefix. */
const budgetRouteOf = (p: BudgetPolicyRecord): BudgetRoute =>
  p.projectId && (p.scopeType === 'project' || p.scopeType === 'repo') ? { kind: 'project', projectId: p.projectId } : { kind: 'admin' };

type BashResult =
  | { kind: 'decided'; approval: FleetApprovalRecord; live: LiveFleetApprovalEvent[]; runnerId: string }
  | { kind: 'closed'; live: LiveFleetApprovalEvent[] }
  | { kind: 'not_pending' };

/**
 * Plan D233: `error` is an i18n coordinate, not free text. `HttpException.initMessage()` falls back to the
 * class name when the response object carries no `message`, so `error.message` stores "Conflict App
 * Exception" and loses the args that say why (a duplicate active job's `activeJobId`); anything else, a
 * Prisma failure included, would store raw internal text into a persisted column. `args` are exactly the
 * values the exception handler interpolates into the user-facing message, so this discloses nothing new.
 */
const errorText = (error: unknown): string =>
  error instanceof AppException ? JSON.stringify({ code: error.prefix, args: error.args }) : 'unexpected error';

/** S1.5 §2.3: list, get, decide and count approvals. Budget decides lock the policy before the approval (§1.4). */
@Injectable()
export class ApprovalsService {
  constructor(
    @Inject(APPROVAL_REPOSITORY) private readonly repo: IApprovalRepository,
    @Inject(BUDGET_REPOSITORY) private readonly budgetRepo: IBudgetRepository,
    private readonly budgets: BudgetsService,
    private readonly jobs: FleetJobsService,
    private readonly closer: ApprovalCloser,
    private readonly live: ApprovalLivePublisher,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobRepo: Pick<IFleetJobRepository, 'lockById' | 'createCommand'>,
    private readonly notifier: RunnerNotifier,
    private readonly assistantActions: AssistantActionPort,
    private readonly permissions: PermissionService,
    private readonly audit: AuditRecorder,
  ) {}

  async list(route: ApprovalRoute, q: { status?: ApprovalStatus; type?: ApprovalType; jobId?: string }, page: IPageOption): Promise<IPageResult<FleetApprovalDto>> {
    const projectId = route.kind === 'project' ? route.projectId : undefined;
    return remapPage(await this.repo.findPage({ ...q, ...(projectId !== undefined ? { projectId } : {}) }, page), (a) => FleetApprovalDto.from(a));
  }

  async get(route: ApprovalRoute, id: string): Promise<FleetApprovalDto> {
    const approval = await this.findVisible(route, id);
    if (approval.type !== 'budget_override_required' || approval.status !== 'pending' || !approval.policyId) return FleetApprovalDto.from(approval);
    return FleetApprovalDto.from(approval, await this.candidates(approval.policyId, approval.requestedAt));
  }

  async decide(caller: ApprovalCaller & { principal: KodaPrincipal }, route: ApprovalRoute, id: string, dto: DecideApprovalDto, now = new Date()): Promise<FleetApprovalDto> {
    const current = await this.findVisible(route, id);
    // Spec §2.3: the approval's type decides which key is needed (permissions P1d US-006), and it is
    // checked before the decision is validated, so an unauthorized caller gets 403 whatever they send,
    // and before txManager.run, so it takes no lock and writes nothing.
    if (current.type === 'nax_bash_escalate') return this.decideBash(caller, current, dto, now);
    // 2a-D8: the creator-only handler owns its own gates, and it has no key yet
    // (`fleet.approval.decide.assistant` belongs to permissions-p1-enforce-assistant).
    if (current.type === 'assistant_action') return FleetApprovalDto.from(await this.assistantActions.decide(caller, current, dto, now));
    if (!(await this.mayDecide(caller.principal, DECIDE_KEYS.budget_override_required, current))) throw new ForbiddenAppException({}, 'permissions');
    if (!current.policyId) invalid('a budget approval with no policy cannot be decided'); // plan D236
    if (dto.decision !== 'keep_paused' && dto.decision !== 'raise_budget_and_resume') invalid(`${dto.decision} does not apply to a budget approval`);
    const policyId: string = current.policyId;

    const t1 = await this.txManager.run(async () => {
      const policy = await this.budgetRepo.lockById(policyId); // lock order: policy first (spec §1.4)
      const approval = await this.repo.lockById(id);
      if (!approval || approval.status !== 'pending') throw new ConflictAppException({}, 'fleet.approvalNotPending');
      // Unreachable while the approval is pending: BudgetsService.remove closes it in the same transaction
      // as the delete, so the CAS above fires first. Checked on both decisions so the branches stay
      // symmetric and a pending approval can never reach `resume` against a policy that is gone.
      if (!policy) throw new ConflictAppException({}, 'fleet.approvalNotPending');
      if (dto.decision === 'keep_paused') {
        const decided = await this.repo.resolve(id, { status: 'rejected', resolvedBy: 'user', decidedAt: now, decision: 'keep_paused', decidedById: caller.id, comment: dto.comment ?? null });
        await this.audit.record({ key: 'fleet.approval.decide.budget', resourceType: 'fleet-approval', resourceId: decided.id, projectId: decided.projectId, summary: 'decision: keep_paused' });
        return { approval: decided, live: await this.closer.recordResolved(decided, userActor(caller.id)), requeue: [] as RequeueCandidate[] };
      }
      if (dto.amountUsd === undefined) invalid('amountUsd is required to raise and resume');
      // `policy.id` is the locked row, not the pre-lock read, so nothing downstream can read as another record.
      const candidates = await this.repo.findRequeueCandidates(policy.id, approval.requestedAt, MAX_REQUEUE_CANDIDATES);
      const byId = new Map(candidates.map((c) => [c.jobId, c]));
      // A subset is a set (spec §1.5): a repeated id would re-queue twice and record `{ok:false}` for a job
      // that in fact succeeded.
      const selected = [...new Set(dto.requeueJobIds ?? [])].map((jobId) => byId.get(jobId) ?? invalid(`job ${jobId} is not a re-queue candidate`));
      const resumed = await this.budgets.resume(caller.id, budgetRouteOf(policy), policy.id, dto.amountUsd, now, { approvalId: id });
      const decided = await this.repo.resolve(id, {
        status: 'approved', resolvedBy: 'user', decidedAt: now, decision: 'raise_budget_and_resume', decidedById: caller.id,
        comment: dto.comment ?? null, outcome: { resumedAmountUsd: resumed.amountUsd, requeueResults: [] },
      });
      await this.audit.record({ key: 'fleet.approval.decide.budget', resourceType: 'fleet-approval', resourceId: decided.id, projectId: decided.projectId, summary: 'decision: raise_budget_and_resume' });
      return { approval: decided, live: await this.closer.recordResolved(decided, userActor(caller.id)), requeue: selected };
    });
    this.live.publish(t1.live);
    if (dto.decision !== 'raise_budget_and_resume') return FleetApprovalDto.from(t1.approval);

    const results: RequeueResult[] = [];
    for (const c of t1.requeue) {
      try {
        await this.jobs.requeue(caller.id, c.projectId, c.jobId); // plan D232: its own transaction
        results.push({ jobId: c.jobId, ok: true });
      } catch (error) {
        results.push({ jobId: c.jobId, ok: false, error: errorText(error) }); // A9, plan D233
      }
    }
    const final = await this.repo.setOutcome(id, { ...(t1.approval.outcome ?? {}), requeueResults: results });
    return FleetApprovalDto.from(final);
  }

  private async decideBash(caller: ApprovalCaller & { principal: KodaPrincipal }, current: FleetApprovalRecord, dto: DecideApprovalDto, now: Date): Promise<FleetApprovalDto> {
    if (!(await this.mayDecide(caller.principal, DECIDE_KEYS.nax_bash_escalate, current))) throw new ForbiddenAppException({}, 'permissions');
    if (dto.amountUsd !== undefined || dto.requeueJobIds !== undefined) {
      throw new ValidationAppException({ reason: 'amountUsd and requeueJobIds apply only to budget approvals' }, 'fleet.approvalInput');   // plan D287
    }
    const checked = checkBashDecision(current.payload, dto.decision);
    if ('reason' in checked) invalid(checked.reason);   // strictNullChecks is off: `in` narrows, `.ok` does not
    const jobId = current.jobId;
    if (!jobId) invalid('a bash approval with no job cannot be decided');
    const result = await this.txManager.run(async (): Promise<BashResult> => {
      const job = await this.jobRepo.lockById(jobId);   // lock order: job first, then approval (spec §1.4)
      const approval = await this.repo.lockById(current.id);
      if (!job || !approval || approval.status !== 'pending') return { kind: 'not_pending' };
      // US-006 security ruling: no agent self-approval. A human may still decide an ask of a job it
      // requested, and a budget ask has no single requester. Thrown inside the transaction, so it
      // rolls back: nothing is written and the ask stays pending.
      if (isAgentPrincipal(caller.principal) && job.requestedById === caller.id && (job.requestedByType ?? 'USER') === 'AGENT') {
        throw new ForbiddenAppException({}, 'fleet.approvalSelfDecide');
      }
      if (job.state !== 'RUNNING' || job.leaseEpoch !== approval.leaseEpoch || job.runnerId === null) {
        // nax has exited or is exiting. Close only THIS ask: on an epoch mismatch the job's other asks belong to a newer lease.
        const ended = await this.repo.resolve(approval.id, { status: 'cancelled', resolvedBy: 'job_ended', decidedAt: now });
        return { kind: 'closed', live: await this.closer.recordResolved(ended, jobSystemActor(job)) };
      }
      if (approval.expiresAt && approval.expiresAt.getTime() <= now.getTime()) {
        return { kind: 'closed', live: (await this.closer.expire(approval, job, now)).live };   // nax has already denied
      }
      const decided = await this.repo.resolve(approval.id, {
        status: checked.status, resolvedBy: 'user', decision: dto.decision, decidedById: caller.id, decidedAt: now,
        comment: dto.comment ?? null,
      });
      await this.jobRepo.createCommand({
        runnerId: job.runnerId, jobId: job.id, type: FleetCommandType.APPROVAL_ANSWER, leaseEpoch: job.leaseEpoch,
        payload: { approvalId: decided.id, naxAskId: decided.naxAskId, choice: checked.choice },
      });
      await this.audit.record({ key: 'fleet.approval.decide.bash', resourceType: 'fleet-approval', resourceId: decided.id, projectId: decided.projectId, summary: `decision: ${dto.decision}` });
      return { kind: 'decided', approval: decided, live: await this.closer.recordResolved(decided, userActor(caller.id)), runnerId: job.runnerId };
    });
    // Plan D265: the expiry or job-end close above has committed; only now refuse the decide.
    if (result.kind !== 'not_pending') this.live.publish(result.live);
    if (result.kind !== 'decided') throw new ConflictAppException({}, 'fleet.approvalNotPending');
    this.notifier.notify(result.runnerId);
    return FleetApprovalDto.from(result.approval);
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
    const projects = 'projectIds' in scope ? await this.repo.countPending(scope.projectIds) : await this.repo.countPendingAllProjects();
    const unscoped = 'projectIds' in scope ? 0 : await this.repo.countPendingUnscoped();
    return Object.assign(new ApprovalCountsDto(), {
      total: projects.reduce((sum, p) => sum + p.pending, unscoped), unscoped, projects,
    });
  }

  /**
   * The key is asked in the approval's own project, or with no project for an ask that has none (a
   * global policy's), so a global grant is what passes there — as the old global-admin check did.
   */
  private async mayDecide(principal: KodaPrincipal, key: string, approval: FleetApprovalRecord): Promise<boolean> {
    return (await this.permissions.can(principal, key, approval.projectId ? { projectId: approval.projectId } : {})).allowed;
  }

  private async findVisible(route: ApprovalRoute, id: string): Promise<FleetApprovalRecord> {
    const approval = await this.repo.findById(id);
    if (!approval || !visible(route, approval)) throw new NotFoundAppException({}, 'fleet.approvals');
    return approval;
  }

  private async candidates(policyId: string, since: Date): Promise<{ rows: RequeueCandidate[]; truncated: boolean }> {
    const rows = await this.repo.findRequeueCandidates(policyId, since, MAX_REQUEUE_CANDIDATES + 1);
    return { rows: rows.slice(0, MAX_REQUEUE_CANDIDATES), truncated: rows.length > MAX_REQUEUE_CANDIDATES };
  }
}

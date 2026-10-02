import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenAppException, NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import type { IPageOption } from '@nathapp/nestjs-common';
import { IPageResult, ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { remapPage } from '../../common/dto/koda-page.query';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { BudgetRoute, BudgetsService } from '../budgets/budgets.service';
import { BUDGET_REPOSITORY, BudgetPolicyRecord, IBudgetRepository } from '../budgets/domain/budget.domain';
import { FleetJobsService } from '../jobs/fleet-jobs.service';
import { ApprovalCloser } from './approval-closer';
import { ApprovalLivePublisher } from './approval-live.publisher';
import {
  APPROVAL_REPOSITORY, ApprovalStatus, ApprovalType, FleetApprovalRecord, IApprovalRepository, MAX_REQUEUE_CANDIDATES, RequeueCandidate,
} from './domain/approval.domain';
import { ApprovalCountsDto } from './dto/approval-counts.dto';
import type { DecideApprovalDto } from './dto/decide-approval.dto';
import { FleetApprovalDto } from './dto/fleet-approval.dto';

/** Which prefix a request came through (plan D230); `role` is the caller's project role. */
export type ApprovalRoute = { kind: 'admin' } | { kind: 'project'; projectId: string; role: string };
export interface ApprovalCaller { id: string; globalAdmin: boolean }

interface RequeueResult { jobId: string; ok: boolean; error?: string }

function invalid(reason: string): never {
  throw new ValidationAppException({ reason }, 'fleet.approvalDecisionInvalid');
}

const visible = (route: ApprovalRoute, a: FleetApprovalRecord): boolean => route.kind === 'admin' || a.projectId === route.projectId;

/** Plan D229: the budgets service's ownership route follows the policy's scope, not the request prefix. */
const budgetRouteOf = (p: BudgetPolicyRecord): BudgetRoute =>
  p.scopeType === 'project' || p.scopeType === 'repo' ? { kind: 'project', projectId: p.projectId as string } : { kind: 'admin' };

/** Spec §1.7: budget asks are decided by whoever may resume the policy (S1b B3). */
const mayDecideBudget = (route: ApprovalRoute): boolean => route.kind === 'admin' || route.role === 'ADMIN';

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
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

  async decide(caller: ApprovalCaller, route: ApprovalRoute, id: string, dto: DecideApprovalDto, now = new Date()): Promise<FleetApprovalDto> {
    const current = await this.findVisible(route, id);
    if (current.type !== 'budget_override_required' || !current.policyId) invalid('bash approvals are not decidable yet'); // plan D236
    if (dto.decision !== 'keep_paused' && dto.decision !== 'raise_budget_and_resume') invalid(`${dto.decision} does not apply to a budget approval`);
    if (!mayDecideBudget(route)) throw new ForbiddenAppException({}, 'projects');
    const policyId = current.policyId as string;

    const t1 = await this.txManager.run(async () => {
      const policy = await this.budgetRepo.lockById(policyId); // lock order: policy first (spec §1.4)
      const approval = await this.repo.lockById(id);
      if (!approval || approval.status !== 'pending') throw new ConflictAppException({}, 'fleet.approvalNotPending');
      if (dto.decision === 'keep_paused') {
        const decided = await this.repo.resolve(id, { status: 'rejected', resolvedBy: 'user', decidedAt: now, decision: 'keep_paused', decidedById: caller.id, comment: dto.comment ?? null });
        return { approval: decided, live: await this.closer.recordResolved(decided, user(caller.id)), requeue: [] as RequeueCandidate[] };
      }
      if (dto.amountUsd === undefined) invalid('amountUsd is required to raise and resume');
      if (!policy) throw new ConflictAppException({}, 'fleet.approvalNotPending');
      const candidates = await this.repo.findRequeueCandidates(policyId, approval.requestedAt, MAX_REQUEUE_CANDIDATES);
      const byId = new Map(candidates.map((c) => [c.jobId, c]));
      const selected = (dto.requeueJobIds ?? []).map((jobId) => byId.get(jobId) ?? invalid(`job ${jobId} is not a re-queue candidate`));
      const resumed = await this.budgets.resume(caller.id, budgetRouteOf(policy), policyId, dto.amountUsd, now, { approvalId: id });
      const decided = await this.repo.resolve(id, {
        status: 'approved', resolvedBy: 'user', decidedAt: now, decision: 'raise_budget_and_resume', decidedById: caller.id,
        comment: dto.comment ?? null, outcome: { resumedAmountUsd: resumed.amountUsd ?? String(dto.amountUsd), requeueResults: [] },
      });
      return { approval: decided, live: await this.closer.recordResolved(decided, user(caller.id)), requeue: selected };
    });
    this.live.publish(t1.live);
    if (t1.approval.decision !== 'raise_budget_and_resume') return FleetApprovalDto.from(t1.approval);

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

  async counts(caller: ApprovalCaller): Promise<ApprovalCountsDto> {
    const projects = await this.repo.countPending(await this.activity.memberProjectIds(caller.id));
    const unscoped = caller.globalAdmin ? await this.repo.countPendingUnscoped() : 0;
    return Object.assign(new ApprovalCountsDto(), {
      total: projects.reduce((sum, p) => sum + p.pending, unscoped), unscoped, projects,
    });
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

const user = (id: string) => ({ type: 'USER' as const, id, responsibleUserId: id });

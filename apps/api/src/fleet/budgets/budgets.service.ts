import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { ApprovalCloser, userActor } from '../approvals/approval-closer';
import { ApprovalLivePublisher } from '../approvals/approval-live.publisher';
import { BudgetEvaluator } from './budget-evaluator';
import { budgetActivityPayload } from './budget-payloads';
import { isAboveSpend, isEffectivelyPaused, scopeKeyOf, spendSince, warnReached, windowStart } from './budget-rules';
import {
  BUDGET_REPOSITORY, BudgetPolicyPatch, BudgetPolicyRecord, BudgetScopeType, DuplicateBudgetPolicyError, IBudgetRepository,
} from './domain/budget.domain';
import { BudgetPolicyDto } from './dto/budget-policy.dto';
import type { CreateBudgetPolicyDto } from './dto/create-budget-policy.dto';
import type { UpdateBudgetPolicyDto } from './dto/update-budget-policy.dto';

export const DEFAULT_WARN_PERCENT = 80;

/** Which prefix a request came through (plan D162). */
export type BudgetRoute = { kind: 'admin' } | { kind: 'project'; projectId: string };

const ADMIN_SCOPES: readonly BudgetScopeType[] = ['global', 'runner'];
const PROJECT_SCOPES: readonly BudgetScopeType[] = ['project', 'repo'];

function fail(reason: string): never {
  throw new ValidationAppException({ reason }, 'fleet.budgetInput');
}

/** Plan D162: admin routes own global and runner policies; a project route owns its project's project and repo policies. */
function owns(route: BudgetRoute, p: BudgetPolicyRecord): boolean {
  return route.kind === 'admin' ? ADMIN_SCOPES.includes(p.scopeType) : PROJECT_SCOPES.includes(p.scopeType) && p.projectId === route.projectId;
}

/** S1b §2.4: policy management. Permission (B3) is the controllers' job; ownership by route is checked here. */
@Injectable()
export class BudgetsService {
  constructor(
    @Inject(BUDGET_REPOSITORY) private readonly repo: IBudgetRepository,
    private readonly evaluator: BudgetEvaluator,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly approvals: ApprovalCloser,
    private readonly approvalLive: ApprovalLivePublisher,
  ) {}

  /** Admin: every policy. Project: the global ones plus the project's project and repo policies. */
  async list(route: BudgetRoute, now = new Date()): Promise<BudgetPolicyDto[]> {
    const policies = route.kind === 'admin' ? await this.repo.findAll() : await this.repo.findVisibleToProject(route.projectId);
    const rows: BudgetPolicyDto[] = [];
    for (const p of policies) rows.push(await this.toDto(p, now));
    return rows;
  }

  async create(actorId: string, route: BudgetRoute, dto: CreateBudgetPolicyDto, now = new Date()): Promise<BudgetPolicyDto> {
    const scope = await this.resolveScope(route, dto);
    let created: BudgetPolicyRecord;
    try {
      created = await this.txManager.run(async () => {
        const policy = await this.repo.create({
          ...scope, scopeKey: scopeKeyOf(scope.scopeType, scope.scopeId), windowKind: dto.windowKind, amountUsd: String(dto.amountUsd),
          warnPercent: dto.warnPercent === undefined ? DEFAULT_WARN_PERCENT : dto.warnPercent,
          hardStop: dto.hardStop ?? true, runningJobs: dto.runningJobs ?? 'finish', createdById: actorId,
        });
        await this.record(actorId, 'budget.created', policy);
        return policy;
      });
    } catch (error) {
      if (error instanceof DuplicateBudgetPolicyError) throw new ConflictAppException({}, 'fleet.budgets');
      throw error;
    }
    this.evaluator.signal([created.scopeKey]); // plan D165
    return this.toDto(created, now);
  }

  async update(actorId: string, route: BudgetRoute, id: string, dto: UpdateBudgetPolicyDto, now = new Date()): Promise<BudgetPolicyDto> {
    const updated = await this.txManager.run(async () => {
      const before = await this.lockOwned(route, id);
      const patch: BudgetPolicyPatch = {
        ...(dto.amountUsd !== undefined ? { amountUsd: String(dto.amountUsd) } : {}),
        ...(dto.warnPercent !== undefined ? { warnPercent: dto.warnPercent } : {}),
        ...(dto.hardStop !== undefined ? { hardStop: dto.hardStop } : {}),
        ...(dto.runningJobs !== undefined ? { runningJobs: dto.runningJobs } : {}),
        updatedById: actorId,
      };
      const after = await this.repo.update(id, patch);
      await this.record(actorId, 'budget.updated', after, {
        before: { amountUsd: before.amountUsd, warnPercent: before.warnPercent, hardStop: before.hardStop, runningJobs: before.runningJobs },
      });
      return after;
    });
    this.evaluator.signal([updated.scopeKey]); // plan D165
    return this.toDto(updated, now);
  }

  /** Deleting a paused policy lifts its pause (the row is gone) and closes its pending approval (S1.5 §1.4). */
  async remove(actorId: string, route: BudgetRoute, id: string): Promise<void> {
    const live = await this.txManager.run(async () => {
      const policy = await this.lockOwned(route, id);
      const closed = await this.approvals.closeForPolicy(id, { status: 'cancelled', resolvedBy: 'policy_deleted', actor: userActor(actorId) }, new Date());
      await this.repo.delete(id);
      await this.record(actorId, 'budget.deleted', policy, { wasPaused: policy.pausedAt !== null });
      return closed.live;
    });
    this.approvalLive.publish(live);
  }

  /**
   * S1b §2.4, B1: optionally raise the amount, clear the pause, record a `resumed` incident.
   * S1.5: with `opts.approvalId` (a raise_budget_and_resume decision) the incident carries that id and nothing is
   * closed here; without it (the budgets page) the pending approval is closed as manual_resume (plan D234).
   */
  async resume(
    actorId: string, route: BudgetRoute, id: string, amountUsd: number | undefined, now = new Date(), opts: { approvalId?: string } = {},
  ): Promise<BudgetPolicyDto> {
    const { resumed, live } = await this.txManager.run(async () => {
      const policy = await this.lockOwned(route, id);
      if (!policy.pausedAt) throw new ConflictAppException({}, 'fleet.budgetNotPaused'); // plan D164
      const spent = await this.repo.windowSpend(policy, spendSince(policy.windowKind, now));
      const amount = amountUsd === undefined ? policy.amountUsd : String(amountUsd);
      if (!isAboveSpend(amount, spent)) throw new ValidationAppException({ amountUsd: amount, spentUsd: spent }, 'fleet.budgetAmountNotAboveSpend');
      const after = await this.repo.update(id, { amountUsd: amount, pausedAt: null, pausedWindowStart: null, updatedById: actorId });
      const closed = opts.approvalId
        ? { approval: null, live: [] }
        : await this.approvals.closeForPolicy(id, {
          status: 'approved', resolvedBy: 'manual_resume', decision: 'raise_budget_and_resume', actor: userActor(actorId),
          outcome: { resumedAmountUsd: amount, requeueResults: [] },
        }, now);
      const approvalId = opts.approvalId ?? closed.approval?.id ?? null;
      await this.repo.insertIncident({ policyId: id, kind: 'resumed', windowStart: windowStart(policy.windowKind, now), spentUsd: spent, amountUsd: amount, actorId, approvalId });
      await this.record(actorId, 'budget.resumed', after, { spentUsd: spent, previousAmountUsd: policy.amountUsd, approvalId });
      return { resumed: after, live: closed.live };
    });
    this.approvalLive.publish(live);
    return this.toDto(resumed, now);
  }

  private async resolveScope(route: BudgetRoute, dto: Pick<CreateBudgetPolicyDto, 'scopeType' | 'scopeId'>): Promise<{ scopeType: BudgetScopeType; scopeId: string | null; projectId: string | null }> {
    const allowed = route.kind === 'admin' ? ADMIN_SCOPES : PROJECT_SCOPES;
    if (!allowed.includes(dto.scopeType)) fail(`scopeType ${dto.scopeType} is managed on the other route`);
    const projectId = route.kind === 'project' ? route.projectId : null;
    switch (dto.scopeType) {
      case 'global':
        if (dto.scopeId !== undefined) fail('a global policy takes no scopeId');
        return { scopeType: 'global', scopeId: null, projectId: null };
      case 'runner':
        if (!dto.scopeId) fail('scopeId (the runner id) is required');
        if (!(await this.repo.scopeExists({ scopeType: 'runner', scopeId: dto.scopeId }))) throw new NotFoundAppException({}, 'fleet.runners');
        return { scopeType: 'runner', scopeId: dto.scopeId, projectId: null };
      case 'project':
        if (dto.scopeId !== undefined && dto.scopeId !== projectId) fail('a project policy names its own project');
        return { scopeType: 'project', scopeId: projectId, projectId };
      case 'repo':
        if (!dto.scopeId) fail('scopeId (the fleet repo id) is required');
        if ((await this.repo.findRepoProjectId(dto.scopeId)) !== projectId) throw new NotFoundAppException({}, 'fleet.repos');
        return { scopeType: 'repo', scopeId: dto.scopeId, projectId };
    }
  }

  private async lockOwned(route: BudgetRoute, id: string): Promise<BudgetPolicyRecord> {
    const policy = await this.repo.lockById(id);
    if (!policy || !owns(route, policy)) throw new NotFoundAppException({}, 'fleet.budgets');
    return policy;
  }

  private async toDto(policy: BudgetPolicyRecord, now: Date): Promise<BudgetPolicyDto> {
    const spentUsd = await this.repo.windowSpend(policy, spendSince(policy.windowKind, now));
    return BudgetPolicyDto.from(policy, {
      spentUsd, windowStart: windowStart(policy.windowKind, now), paused: isEffectivelyPaused(policy, now),
      warnReached: warnReached(spentUsd, policy.amountUsd, policy.warnPercent),
    });
  }

  private record(actorId: string, action: string, policy: BudgetPolicyRecord, extra: Record<string, unknown> = {}): Promise<void> {
    return this.activity.record({
      actorType: 'USER', actorId, action, entityType: 'budget', entityId: policy.id, projectId: policy.projectId,
      responsibleUserId: actorId, payload: budgetActivityPayload(policy, extra),
    });
  }
}

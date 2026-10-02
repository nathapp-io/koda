import { Injectable } from '@nestjs/common';
import { BudgetPolicy as PolicyRow, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { randomUUID } from 'crypto';
import { FleetJobState } from '../../common/enums';
import {
  BudgetPolicyPatch, BudgetPolicyRecord, BudgetRunningJobs, BudgetScope, BudgetScopeType, BudgetWindowKind,
  DuplicateBudgetPolicyError, IBudgetRepository, NewBudgetIncident, NewBudgetPolicy,
} from './domain/budget.domain';

const toPolicy = (r: PolicyRow): BudgetPolicyRecord => ({
  ...r,
  scopeType: r.scopeType as BudgetScopeType,
  windowKind: r.windowKind as BudgetWindowKind,
  runningJobs: r.runningJobs as BudgetRunningJobs,
  amountUsd: r.amountUsd.toString(),
});

const ORDER: Prisma.BudgetPolicyOrderByWithRelationInput[] = [{ scopeKey: 'asc' }, { windowKind: 'asc' }];
const OLDEST_FIRST: Prisma.FleetJobOrderByWithRelationInput[] = [{ queuedAt: 'asc' }, { id: 'asc' }];

/** S1b §2.1 scope filter; `runnerField` picks the pin (QUEUED) or the holder (spend, held jobs). */
function jobScope(scope: BudgetScope, runnerField: 'runnerId' | 'pinnedRunnerId'): Prisma.FleetJobWhereInput {
  switch (scope.scopeType) {
    case 'global': return {};
    case 'project': return { projectId: scope.scopeId ?? '' };
    case 'repo': return { repoId: scope.scopeId ?? '' };
    case 'runner': return { [runnerField]: scope.scopeId ?? '' };
  }
}

@Injectable()
export class PrismaBudgetRepository implements IBudgetRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  /** Transaction-scoped inside txManager.run (nestjs-prisma ALS proxy). */
  private get db() {
    return this.prisma.client;
  }

  async findById(id: string): Promise<BudgetPolicyRecord | null> {
    const r = await this.db.budgetPolicy.findUnique({ where: { id } });
    return r ? toPolicy(r) : null;
  }

  async lockById(id: string): Promise<BudgetPolicyRecord | null> {
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "BudgetPolicy" WHERE "id" = ${id} FOR UPDATE`;
    return rows.length === 0 ? null : this.findById(id);
  }

  async findAll(): Promise<BudgetPolicyRecord[]> {
    return (await this.db.budgetPolicy.findMany({ orderBy: ORDER })).map(toPolicy);
  }

  async findByScopeKeys(keys: readonly string[]): Promise<BudgetPolicyRecord[]> {
    if (keys.length === 0) return [];
    return (await this.db.budgetPolicy.findMany({ where: { scopeKey: { in: [...keys] } }, orderBy: ORDER })).map(toPolicy);
  }

  async findVisibleToProject(projectId: string): Promise<BudgetPolicyRecord[]> {
    const rows = await this.db.budgetPolicy.findMany({ where: { OR: [{ scopeType: 'global' }, { projectId }] }, orderBy: ORDER });
    return rows.map(toPolicy);
  }

  async findPaused(): Promise<BudgetPolicyRecord[]> {
    return (await this.db.budgetPolicy.findMany({ where: { pausedAt: { not: null } }, orderBy: ORDER })).map(toPolicy);
  }

  async create(data: NewBudgetPolicy): Promise<BudgetPolicyRecord> {
    try {
      return toPolicy(await this.db.budgetPolicy.create({
        data: { ...data, amountUsd: new Prisma.Decimal(data.amountUsd), updatedById: data.createdById },
      }));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new DuplicateBudgetPolicyError();
      throw error;
    }
  }

  async update(id: string, patch: BudgetPolicyPatch): Promise<BudgetPolicyRecord> {
    const { amountUsd, ...rest } = patch;
    const data: Prisma.BudgetPolicyUpdateInput = { ...rest, ...(amountUsd !== undefined ? { amountUsd: new Prisma.Decimal(amountUsd) } : {}) };
    return toPolicy(await this.db.budgetPolicy.update({ where: { id }, data }));
  }

  async delete(id: string): Promise<void> {
    await this.db.budgetPolicy.delete({ where: { id } });
  }

  async scopeExists(scope: BudgetScope): Promise<boolean> {
    if (scope.scopeType === 'global') return true;
    if (!scope.scopeId) return false;
    const id = scope.scopeId;
    switch (scope.scopeType) {
      case 'project': return (await this.db.project.count({ where: { id, deletedAt: null } })) > 0;
      case 'repo': return (await this.db.fleetRepo.count({ where: { id } })) > 0;
      case 'runner': return (await this.db.runner.count({ where: { id } })) > 0;
    }
  }

  async findRepoProjectId(repoId: string): Promise<string | null> {
    return (await this.db.fleetRepo.findUnique({ where: { id: repoId }, select: { projectId: true } }))?.projectId ?? null;
  }

  async windowSpend(scope: BudgetScope, since: Date | null): Promise<string> {
    const agg = await this.db.fleetJob.aggregate({
      where: { ...jobScope(scope, 'runnerId'), ...(since ? { firstStartedAt: { gte: since } } : {}) },
      _sum: { costSpentUsd: true, costCarriedUsd: true },
    });
    return new Prisma.Decimal(agg._sum.costSpentUsd ?? 0).add(agg._sum.costCarriedUsd ?? 0).toString();
  }

  async insertIncident(i: NewBudgetIncident): Promise<boolean> {
    // Bind timestamps as ISO text cast to timestamp(3) (UTC), as casAssign does.
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "BudgetIncident" ("id", "policyId", "kind", "windowStart", "spentUsd", "amountUsd", "actorId")
      VALUES (${randomUUID()}, ${i.policyId}, ${i.kind}, CAST(${i.windowStart.toISOString()} AS timestamp(3)),
              CAST(${i.spentUsd} AS DECIMAL(12,4)), CAST(${i.amountUsd} AS DECIMAL(12,4)), ${i.actorId})
      ON CONFLICT DO NOTHING
      RETURNING "id"`;
    return rows.length > 0;
  }

  async findQueuedJobIds(scope: BudgetScope): Promise<string[]> {
    const rows = await this.db.fleetJob.findMany({
      where: { ...jobScope(scope, 'pinnedRunnerId'), state: FleetJobState.QUEUED }, orderBy: OLDEST_FIRST, select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async findHeldJobIds(scope: BudgetScope): Promise<string[]> {
    const rows = await this.db.fleetJob.findMany({
      where: { ...jobScope(scope, 'runnerId'), state: { in: [FleetJobState.ASSIGNED, FleetJobState.RUNNING] } },
      orderBy: OLDEST_FIRST, select: { id: true },
    });
    return rows.map((r) => r.id);
  }
}

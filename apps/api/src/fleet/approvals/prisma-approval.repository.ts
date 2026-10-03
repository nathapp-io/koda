import { Injectable } from '@nestjs/common';
import { FleetApproval as ApprovalRow, Prisma, PrismaClient } from '@prisma/client';
import { Paginate, PrismaService } from '@nathapp/nestjs-prisma';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { FleetJobState } from '../../common/enums';
import { budgetReason } from '../budgets/budget-rules';
import {
  ApprovalDecision, ApprovalFilters, ApprovalResolution, ApprovalResolvedBy, ApprovalStatus, ApprovalType, FleetApprovalRecord,
  IApprovalRepository, NewFleetApproval, PendingCount, RequeueCandidate,
} from './domain/approval.domain';

const asObject = (v: Prisma.JsonValue | null): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const toApproval = (r: ApprovalRow): FleetApprovalRecord => ({
  ...r,
  type: r.type as ApprovalType,
  status: r.status as ApprovalStatus,
  decision: r.decision as ApprovalDecision | null,
  resolvedBy: r.resolvedBy as ApprovalResolvedBy | null,
  payload: asObject(r.payload) ?? {},
  outcome: asObject(r.outcome),
});

const json = (v: Record<string, unknown>): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

@Injectable()
export class PrismaApprovalRepository implements IApprovalRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  /** Transaction-scoped inside txManager.run (nestjs-prisma ALS proxy). */
  private get db() {
    return this.prisma.client;
  }

  async create(d: NewFleetApproval): Promise<FleetApprovalRecord> {
    return toApproval(await this.db.fleetApproval.create({
      data: {
        type: d.type, projectId: d.projectId, policyId: d.policyId, payload: json(d.payload), requestedAt: d.requestedAt,
        jobId: d.jobId ?? null, leaseEpoch: d.leaseEpoch ?? null, naxAskId: d.naxAskId ?? null, expiresAt: d.expiresAt ?? null,
      },
    }));
  }

  async findById(id: string): Promise<FleetApprovalRecord | null> {
    const r = await this.db.fleetApproval.findUnique({ where: { id } });
    return r ? toApproval(r) : null;
  }

  async lockById(id: string): Promise<FleetApprovalRecord | null> {
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "FleetApproval" WHERE "id" = ${id} FOR UPDATE`;
    return rows.length === 0 ? null : this.findById(id);
  }

  async findPendingForPolicy(policyId: string): Promise<FleetApprovalRecord | null> {
    const r = await this.db.fleetApproval.findFirst({ where: { policyId, status: 'pending' } });
    return r ? toApproval(r) : null;
  }

  async findByAsk(jobId: string, leaseEpoch: number, naxAskId: string): Promise<FleetApprovalRecord | null> {
    const row = await this.db.fleetApproval.findUnique({ where: { jobId_leaseEpoch_naxAskId: { jobId, leaseEpoch, naxAskId } } });
    return row ? toApproval(row) : null;
  }

  async findPendingForJob(jobId: string): Promise<FleetApprovalRecord[]> {
    const rows = await this.db.fleetApproval.findMany({
      where: { jobId, status: 'pending', type: 'nax_bash_escalate' }, orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toApproval);
  }

  async findExpiredPending(now: Date, limit: number): Promise<FleetApprovalRecord[]> {
    const rows = await this.db.fleetApproval.findMany({
      where: { status: 'pending', type: 'nax_bash_escalate', expiresAt: { lte: now } },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }], take: limit,
    });
    return rows.map(toApproval);
  }

  async countPendingByJob(jobIds: readonly string[]): Promise<Map<string, number>> {
    if (jobIds.length === 0) return new Map();
    const groups = await this.db.fleetApproval.groupBy({
      by: ['jobId'], where: { status: 'pending', jobId: { in: [...jobIds] } }, _count: { _all: true },
    });
    return new Map(groups.filter((g) => g.jobId !== null).map((g) => [g.jobId as string, g._count._all]));
  }

  async resolve(id: string, x: ApprovalResolution): Promise<FleetApprovalRecord> {
    return toApproval(await this.db.fleetApproval.update({
      where: { id },
      data: {
        status: x.status, resolvedBy: x.resolvedBy, decidedAt: x.decidedAt, decision: x.decision ?? null,
        decidedById: x.decidedById ?? null, comment: x.comment ?? null,
        ...(x.outcome !== undefined ? { outcome: x.outcome === null ? Prisma.DbNull : json(x.outcome) } : {}),
      },
    }));
  }

  async setOutcome(id: string, outcome: Record<string, unknown>): Promise<FleetApprovalRecord> {
    return toApproval(await this.db.fleetApproval.update({ where: { id }, data: { outcome: json(outcome) } }));
  }

  async findPage(f: ApprovalFilters, page: IPageOption): Promise<IPageResult<FleetApprovalRecord>> {
    const where: Prisma.FleetApprovalWhereInput = {
      ...(f.projectId !== undefined ? { projectId: f.projectId } : {}),
      ...(f.status ? { status: f.status } : {}),
      ...(f.type ? { type: f.type } : {}),
      ...(f.jobId ? { jobId: f.jobId } : {}),
    };
    const rows = await Paginate(this.db.fleetApproval, page, { where, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }] });
    return rows.remap((r: ApprovalRow) => toApproval(r));
  }

  async countPending(projectIds: readonly string[]): Promise<PendingCount[]> {
    if (projectIds.length === 0) return [];
    const groups = await this.db.fleetApproval.groupBy({
      by: ['projectId'], where: { status: 'pending', projectId: { in: [...projectIds] } }, _count: { _all: true },
    });
    const ids = groups.map((g) => g.projectId).filter((id): id is string => id !== null);
    // The badge polls every 60 s and no member project holding a pending approval is the common case;
    // without this it would still ask Postgres for `id IN ()`.
    if (ids.length === 0) return [];
    const projects = await this.db.project.findMany({ where: { id: { in: ids } }, select: { id: true, slug: true } });
    const slugOf = new Map(projects.map((p) => [p.id, p.slug]));
    return groups
      .filter((g) => g.projectId !== null && slugOf.has(g.projectId))
      .map((g) => ({ projectId: g.projectId as string, slug: slugOf.get(g.projectId as string) as string, pending: g._count._all }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }

  countPendingUnscoped(): Promise<number> {
    return this.db.fleetApproval.count({ where: { status: 'pending', projectId: null } });
  }

  async findRequeueCandidates(policyId: string, since: Date, limit: number): Promise<RequeueCandidate[]> {
    const rows = await this.db.fleetJob.findMany({
      where: { state: FleetJobState.CANCELLED, cancelReason: budgetReason(policyId), startedAt: null, finishedAt: { gte: since } },
      orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, projectId: true, feature: true, queuedAt: true },
    });
    return rows.map((r) => ({ jobId: r.id, projectId: r.projectId, feature: r.feature, queuedAt: r.queuedAt }));
  }

  async findProjectSlug(projectId: string): Promise<string | null> {
    return (await this.db.project.findUnique({ where: { id: projectId }, select: { slug: true } }))?.slug ?? null;
  }
}

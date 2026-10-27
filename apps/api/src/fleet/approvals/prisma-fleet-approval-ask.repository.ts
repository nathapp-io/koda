import { Inject, Injectable, Logger } from '@nestjs/common';
import { AbstractPrismaRepository, Paginate, PrismaService, type PrismaModelDelegate } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER, type IPageResult, type ITransactionManager } from '@nathapp/nestjs-data';
import type { IPageOption } from '@nathapp/nestjs-common';
import { Prisma, type ApprovalDecision, type ApprovalRequest, type FleetApprovalAsk as AskModel, type PrismaClient } from '../../generated/prisma/client';
import { FleetJobState } from '../../common/enums';
import { budgetReason } from '../budgets/budget-rules';
import type { ApprovalDecisionRecord, ApprovalRequestRecord, ApprovalRequestStatus } from '../../approvals/domain/approval.domain';
import type {
  ApprovalFilters, ApprovalResolvedBy, FleetApprovalRecord, PendingCount, RequeueCandidate,
} from './domain/approval.domain';
import { FLEET_ASK_KEY, FLEET_ASK_KEYS } from './domain/approval.domain';
import {
  FleetApprovalAskRecord, FleetAskKind, FleetAskWithStatus, IFleetApprovalAskRepository, MAX_COUNTED_PROJECTS,
  MAX_PENDING_ASKS_PER_JOB, NewFleetApprovalAsk,
} from './domain/fleet-approval-ask.domain';
import { fleetStatusWhere, toFleetApproval, type FleetAskRow } from './fleet-approval-view';

/** `outcome` is a JSON object in the domain and a `Json?` column in the row. */
const asObject = (value: Prisma.JsonValue | null): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const json = (value: Record<string, unknown>): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

/**
 * The request with the two relations the fleet view needs: its link, and its last decision only (a
 * decided request may carry several, and the fleet reports the latest).
 */
const ASK_INCLUDE = {
  fleetAsk: true,
  decisions: { orderBy: { decidedAt: 'desc' }, take: 1 },
} as const satisfies Prisma.ApprovalRequestInclude;
type RequestWithAsk = Prisma.ApprovalRequestGetPayload<{ include: typeof ASK_INCLUDE }>;

/**
 * How many pages of MAX_COUNTED_PROJECTS project groups `countPendingAllProjects` may read. Soft-deleted
 * projects are filtered per page, so a page can yield fewer live rows than it contains; this is the hard
 * iteration cap (`.nax/rules/api-data.md`) that keeps that scan bounded anyway.
 */
const MAX_PENDING_COUNT_PAGES = 4;

/**
 * Permissions P3d-1 (US-009): the `FleetApprovalAsk` link table. Module-private — `ApprovalStoreModule`
 * provides it behind `FLEET_APPROVAL_ASK_REPOSITORY` and publishes `FleetApprovalAskStore` instead.
 */
@Injectable()
export class PrismaFleetApprovalAskRepository
  extends AbstractPrismaRepository<FleetApprovalAskRecord, AskModel, string>
  implements IFleetApprovalAskRepository {
  private readonly logger = new Logger(PrismaFleetApprovalAskRepository.name);

  constructor(@Inject(TRANSACTION_MANAGER) tx: ITransactionManager, private readonly prisma: PrismaService<PrismaClient>) {
    super(tx);
  }

  /** Transaction-scoped inside txManager.run (nestjs-prisma ALS proxy). */
  private get db() {
    return this.prisma.client;
  }

  protected modelDelegate(client: unknown): PrismaModelDelegate<AskModel, string> {
    return (client as Record<string, unknown>).fleetApprovalAsk as PrismaModelDelegate<AskModel, string>;
  }

  protected toDomain(model: AskModel): FleetApprovalAskRecord {
    return toAskRecord(model);
  }

  protected toPersistenceCreate(record: FleetApprovalAskRecord) {
    return this.toPersistenceUpdate(record);
  }

  protected toPersistenceUpdate(patch: Partial<FleetApprovalAskRecord>) {
    const { outcome, ...fields } = patch;
    return {
      ...fields,
      // A `Json?` column takes `Prisma.DbNull` for "no value": a plain `null` is refused.
      ...(outcome !== undefined ? { outcome: outcome === null ? Prisma.DbNull : json(outcome) } : {}),
    };
  }

  async insert(data: NewFleetApprovalAsk): Promise<FleetApprovalAskRecord> {
    const row = await this.db.fleetApprovalAsk.create({
      data: {
        requestId: data.requestId,
        kind: data.kind,
        projectId: data.projectId,
        jobId: data.jobId ?? null,
        leaseEpoch: data.leaseEpoch ?? null,
        naxAskId: data.naxAskId ?? null,
        budgetPolicyId: data.budgetPolicyId ?? null,
      },
    });
    return this.toDomain(row);
  }

  async findByRequest(requestId: string): Promise<FleetApprovalAskRecord | null> {
    const row = await this.db.fleetApprovalAsk.findUnique({ where: { requestId } });
    return row ? this.toDomain(row) : null;
  }

  async findByAsk(jobId: string, leaseEpoch: number, naxAskId: string): Promise<FleetAskWithStatus | null> {
    const row = await this.db.fleetApprovalAsk.findUnique({
      where: { jobId_leaseEpoch_naxAskId: { jobId, leaseEpoch, naxAskId } },
      include: { request: { select: { status: true } } },
    });
    if (!row) return null;
    // The join is not part of the link record: keep it out of the domain shape.
    const { request, ...ask } = row;
    return { ask: this.toDomain(ask), status: request.status as ApprovalRequestStatus };
  }

  async lockByRequest(requestId: string): Promise<FleetApprovalAskRecord | null> {
    const rows = await this.db.$queryRaw<Array<{ requestId: string }>>`SELECT "requestId" FROM "FleetApprovalAsk" WHERE "requestId" = ${requestId} FOR UPDATE`;
    return rows.length === 0 ? null : this.findByRequest(requestId);
  }

  async findPendingForJob(jobId: string): Promise<FleetApprovalAskRecord[]> {
    const rows = await this.db.fleetApprovalAsk.findMany({
      where: { jobId, request: { status: 'pending' } },
      orderBy: [{ request: { createdAt: 'asc' } }, { requestId: 'asc' }],
      take: MAX_PENDING_ASKS_PER_JOB,
    });
    return rows.map((row) => this.toDomain(row));
  }

  async findPendingForPolicy(budgetPolicyId: string): Promise<FleetApprovalAskRecord | null> {
    const row = await this.db.fleetApprovalAsk.findFirst({
      where: { budgetPolicyId, request: { status: 'pending' } },
      orderBy: [{ request: { createdAt: 'asc' } }, { requestId: 'asc' }],
    });
    return row ? this.toDomain(row) : null;
  }

  async setResolvedBy(requestId: string, resolvedBy: ApprovalResolvedBy): Promise<FleetApprovalAskRecord> {
    const row = await this.db.fleetApprovalAsk.update({ where: { requestId }, data: { resolvedBy } });
    return this.toDomain(row);
  }

  async setOutcome(requestId: string, outcome: Record<string, unknown>): Promise<FleetApprovalAskRecord> {
    const row = await this.db.fleetApprovalAsk.update({ where: { requestId }, data: { outcome: json(outcome) } });
    return this.toDomain(row);
  }

  async findApproval(requestId: string): Promise<FleetApprovalRecord | null> {
    const row = await this.db.approvalRequest.findFirst({
      where: { id: requestId, permissionKey: { in: [...FLEET_ASK_KEYS] }, fleetAsk: { isNot: null } },
      include: ASK_INCLUDE,
    });
    return row === null ? null : asApproval(row);
  }

  async findPage(f: ApprovalFilters, page: IPageOption): Promise<IPageResult<FleetApprovalRecord>> {
    // The link existence is its own condition, so a status branch's relation filter adds to it rather
    // than replacing it: a fleet-key request without a link is in neither the list nor the total.
    const filters: Prisma.ApprovalRequestWhereInput[] = [{ fleetAsk: { isNot: null } }];
    if (f.status !== undefined) filters.push(fleetStatusWhere(f.status));
    if (f.jobId !== undefined) filters.push({ fleetAsk: { jobId: f.jobId } });
    const where: Prisma.ApprovalRequestWhereInput = {
      permissionKey: f.type !== undefined ? FLEET_ASK_KEY[f.type] : { in: [...FLEET_ASK_KEYS] },
      ...(f.projectId !== undefined ? { projectId: f.projectId } : {}),
      AND: filters,
    };
    const rows = await Paginate(this.db.approvalRequest, page, {
      where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: ASK_INCLUDE,
    });
    return rows.remap((row: RequestWithAsk) => asApproval(row));
  }

  async countPending(projectIds: readonly string[]): Promise<PendingCount[]> {
    if (projectIds.length === 0) return [];
    const groups = await this.db.approvalRequest.groupBy({
      by: ['projectId'],
      where: pendingWhere({ projectId: { in: [...projectIds] } }),
      _count: { _all: true },
    });
    return this.toPendingCounts(groups);
  }

  /**
   * US-006: every project's pending fleet asks for a caller with a global `fleet.approval.read` grant.
   * A soft-deleted project is excluded, so a project that is gone never shows a badge — and because the
   * exclusion happens before a project counts against the bound, deleted projects can never spend it.
   *
   * `ApprovalRequest.projectId` has no relation (a deleted project leaves its asks readable), so the
   * live check cannot ride the group query: the groups are read in bounded pages of at most
   * MAX_COUNTED_PROJECTS until MAX_PENDING_COUNT_PAGES of them have been read or a page comes back
   * short, and each page is filtered by its projects in one bounded lookup.
   */
  async countPendingAllProjects(): Promise<PendingCount[]> {
    const counted = new Map<string, PendingCount>();
    let truncated = false;
    let fullPage = true;

    for (let page = 0; page < MAX_PENDING_COUNT_PAGES && fullPage; page += 1) {
      const groups = await this.db.approvalRequest.groupBy({
        by: ['projectId'],
        where: pendingWhere({ projectId: { not: null } }),
        _count: { _all: true },
        // The page bound needs a deterministic order, or two reads of the same installation disagree.
        orderBy: { projectId: 'asc' },
        take: MAX_COUNTED_PROJECTS,
        skip: page * MAX_COUNTED_PROJECTS,
      });
      fullPage = groups.length === MAX_COUNTED_PROJECTS;
      for (const entry of await this.toPendingCounts(groups, true)) {
        if (counted.size < MAX_COUNTED_PROJECTS) counted.set(entry.projectId, entry);
        else truncated = true;
      }
    }
    // A full last page means more project groups exist than the scan was allowed to read.
    if (fullPage) truncated = true;

    if (truncated) {
      this.logger.warn(
        `countPendingAllProjects: more than ${MAX_COUNTED_PROJECTS} live projects have a pending fleet ask; the tail is not counted`,
      );
    }
    return [...counted.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  }

  countPendingUnscoped(): Promise<number> {
    return this.db.approvalRequest.count({ where: pendingWhere({ projectId: null }) });
  }

  async countPendingByJob(jobIds: readonly string[]): Promise<Map<string, number>> {
    if (jobIds.length === 0) return new Map();
    const groups = await this.db.fleetApprovalAsk.groupBy({
      by: ['jobId'],
      where: {
        jobId: { in: [...jobIds] },
        request: { status: 'pending', permissionKey: { in: [...FLEET_ASK_KEYS] } },
      },
      _count: { _all: true },
    });
    return new Map(groups.filter((g) => g.jobId !== null).map((g) => [g.jobId as string, g._count._all]));
  }

  /**
   * The rows of a `groupBy` read, with their slugs, in slug order. `liveOnly` drops a soft-deleted
   * project: `countPending` keeps today's behaviour and only the unfiltered read needs it.
   */
  private async toPendingCounts(
    groups: Array<{ projectId: string | null; _count: { _all: number } }>,
    liveOnly = false,
  ): Promise<PendingCount[]> {
    const ids = groups.map((g) => g.projectId).filter((id): id is string => id !== null);
    // A caller with a global grant and no pending ask anywhere is the common case; without this it
    // would still ask Postgres for `id IN ()`.
    if (ids.length === 0) return [];
    const projects = await this.db.project.findMany({
      where: { id: { in: ids }, ...(liveOnly ? { deletedAt: null } : {}) }, select: { id: true, slug: true },
    });
    const slugOf = new Map(projects.map((p) => [p.id, p.slug]));
    return groups
      .filter((g) => g.projectId !== null && slugOf.has(g.projectId))
      .map((g) => ({ projectId: g.projectId as string, slug: slugOf.get(g.projectId as string) as string, pending: g._count._all }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }

  async findRequeueCandidates(policyId: string, since: Date, limit: number): Promise<RequeueCandidate[]> {
    const rows = await this.db.fleetJob.findMany({
      where: {
        state: FleetJobState.CANCELLED, cancelReason: budgetReason(policyId), startedAt: null, finishedAt: { gte: since },
      },
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

/** A pending fleet ask that has its link: the rows `countPending*` count, whatever else narrows them. */
const pendingWhere = (narrow: Prisma.ApprovalRequestWhereInput): Prisma.ApprovalRequestWhereInput => ({
  // The narrow first: the three conditions below are what makes a row one of these counts.
  ...narrow,
  status: 'pending',
  permissionKey: { in: [...FLEET_ASK_KEYS] },
  fleetAsk: { isNot: null },
});

/**
 * The request row as the engine's domain record. The Prisma row names the actor's two halves apart and
 * carries `updatedAt`, which the request contract does not have.
 */
const toRequestRecord = (row: ApprovalRequest): ApprovalRequestRecord => {
  const { actorType, actorId, onBehalfOfType, onBehalfOfId, updatedAt: _updatedAt, ...fields } = row;
  return {
    ...fields,
    actor: { type: actorType as ApprovalRequestRecord['actor']['type'], id: actorId },
    onBehalfOf: onBehalfOfType !== null && onBehalfOfId !== null
      ? { type: onBehalfOfType as 'USER' | 'AGENT', id: onBehalfOfId }
      : null,
  } as ApprovalRequestRecord;
};

/** A database NULL reads back as `params: null`, the shape the domain states for "no params". */
const toDecisionRecord = (row: ApprovalDecision): ApprovalDecisionRecord =>
  ({ ...row, params: row.params ?? null }) as ApprovalDecisionRecord;

/** The link row as its domain record: the two string columns are unions in the domain. */
const toAskRecord = (model: AskModel): FleetApprovalAskRecord => ({
  ...model,
  kind: model.kind as FleetAskKind,
  resolvedBy: model.resolvedBy as ApprovalResolvedBy | null,
  outcome: asObject(model.outcome),
});

/** One page row (or one lookup) mapped through the pure view. The readers only select rows with a link. */
function asApproval(row: RequestWithAsk): FleetApprovalRecord {
  const { fleetAsk, decisions, ...request } = row;
  if (fleetAsk === null) throw new Error(`fleet approval request ${row.id} has no ask link`);
  return toFleetApproval({
    request: toRequestRecord(request),
    link: toAskRecord(fleetAsk),
    decision: decisions[0] === undefined ? null : toDecisionRecord(decisions[0]),
  });
}

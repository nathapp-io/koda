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
  MAX_PENDING_ASKS_PER_JOB, JobEndAsk, NewFleetApprovalAsk, PolicyAskClose,
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

  async findPendingForJobPage(jobId: string, afterRequestId?: string, limit = MAX_PENDING_ASKS_PER_JOB): Promise<FleetApprovalAskRecord[]> {
    const rows = await this.db.fleetApprovalAsk.findMany({
      where: {
        jobId,
        request: { status: 'pending' },
        // Keyset, not offset: closing a page removes it from the filter, so an offset would skip rows.
        ...(afterRequestId === undefined ? {} : { requestId: { gt: afterRequestId } }),
      },
      orderBy: { requestId: 'asc' },
      take: limit,
    });
    return rows.map((row) => this.toDomain(row));
  }

  /**
   * A durable fair queue over individual asks, not the oldest ten jobs. Holding a request must not consume a
   * batch slot; a failing close must not reset the queue position. The caller commits this audited scheduling
   * write separately, then closes each selected request in its own audited transaction. A crash just delays a
   * selected ask until the queue rotates. No job lock is held and request locks are always skip-locked.
   *
   * updatedAt is the link's last scheduling/mutation time (resolved links leave the queue). Database time, not
   * tick(now), keeps attempts ordered even when a caller supplies a future expiry-test clock.
   */
  claimEndedJobAsks(limit: number): Promise<JobEndAsk[]> {
    return this.db.$queryRaw<JobEndAsk[]>`
      WITH next AS (
        SELECT a."requestId"
        FROM "FleetApprovalAsk" a
        JOIN "ApprovalRequest" r ON r."id" = a."requestId"
        JOIN "FleetJob" j ON j."id" = a."jobId"
        WHERE a."kind" = 'bash' AND r."status" = 'pending' AND j."state" <> 'RUNNING'
        ORDER BY a."updatedAt" ASC, a."requestId" ASC
        LIMIT ${limit}
        FOR UPDATE OF r, a SKIP LOCKED
      )
      UPDATE "FleetApprovalAsk" a SET "updatedAt" = clock_timestamp()
      FROM next WHERE a."requestId" = next."requestId"
      RETURNING a."requestId", a."jobId", a."projectId"
    `;
  }

  async findPendingForPolicyPage(budgetPolicyId: string, afterRequestId?: string, limit = MAX_PENDING_ASKS_PER_JOB): Promise<FleetApprovalAskRecord[]> {
    const rows = await this.db.fleetApprovalAsk.findMany({
      where: {
        budgetPolicyId,
        request: { status: 'pending' },
        // Keyset, not offset: closing a page removes it from the filter, so an offset would skip rows.
        ...(afterRequestId === undefined ? {} : { requestId: { gt: afterRequestId } }),
      },
      orderBy: { requestId: 'asc' },
      take: limit,
    });
    return rows.map((row) => this.toDomain(row));
  }

  /**
   * US-007 (fix round 2): stamp the close's intent on every pending ask of the policy before the close starts, so an
   * ask it cannot settle (held, or past the call's bound) keeps the reason that action chose.
   */
  async markPendingPolicyAsks(budgetPolicyId: string, resolvedBy: ApprovalResolvedBy): Promise<number> {
    const { count } = await this.db.fleetApprovalAsk.updateMany({
      where: { budgetPolicyId, request: { status: 'pending' } },
      data: { pendingResolvedBy: resolvedBy },
    });
    return count;
  }

  /**
   * The durable policy-close queue: individual asks, ordered by the link's last update, skip-locking held rows and
   * moving the selected batch to the tail before any close is attempted. A crash after scheduling just delays the ask.
   */
  claimPendingPolicyAsks(limit: number): Promise<PolicyAskClose[]> {
    return this.db.$queryRaw<PolicyAskClose[]>`
      WITH next AS (
        SELECT a."requestId"
        FROM "FleetApprovalAsk" a
        JOIN "ApprovalRequest" r ON r."id" = a."requestId"
        WHERE a."kind" = 'budget' AND a."pendingResolvedBy" IS NOT NULL AND r."status" = 'pending'
        ORDER BY a."updatedAt" ASC, a."requestId" ASC
        LIMIT ${limit}
        FOR UPDATE OF r, a SKIP LOCKED
      )
      UPDATE "FleetApprovalAsk" a SET "updatedAt" = clock_timestamp()
      FROM next WHERE a."requestId" = next."requestId"
      RETURNING a."requestId", a."budgetPolicyId", a."projectId", a."pendingResolvedBy"
    `;
  }

  async setRecordedStatus(requestId: string, recordedStatus: string): Promise<FleetApprovalAskRecord> {
    const row = await this.db.fleetApprovalAsk.update({ where: { requestId }, data: { recordedStatus } });
    return this.toDomain(row);
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
   *
   * A soft-deleted project never shows a badge, and it must not spend a slot of the answer either, so
   * the soft-delete rule is applied by the database *before* the bound. That rules out the Prisma
   * group query: `ApprovalRequest.projectId` has no relation to `Project` (a deleted project leaves its
   * asks readable), and no page-scan of it can promise to reach live projects that sort behind an
   * arbitrary number of deleted ones. One bounded join answers it instead: at most
   * MAX_COUNTED_PROJECTS + 1 grouped rows, ordered by slug, so the answer is the first
   * MAX_COUNTED_PROJECTS live projects and the truncation is logged.
   */
  async countPendingAllProjects(): Promise<PendingCount[]> {
    const rows = await this.db.$queryRaw<Array<{ projectId: string; slug: string; pending: number }>>`
      SELECT r."projectId" AS "projectId", p."slug" AS "slug", COUNT(*)::int AS "pending"
      FROM "ApprovalRequest" r
      JOIN "Project" p ON p."id" = r."projectId"
      JOIN "FleetApprovalAsk" a ON a."requestId" = r."id"
      WHERE r."status" = 'pending'
        AND p."deletedAt" IS NULL
        AND r."permissionKey" IN (${Prisma.join([...FLEET_ASK_KEYS])})
      GROUP BY r."projectId", p."slug"
      ORDER BY p."slug" ASC
      LIMIT ${MAX_COUNTED_PROJECTS + 1}
    `;
    if (rows.length > MAX_COUNTED_PROJECTS) {
      this.logger.warn(
        `countPendingAllProjects: more than ${MAX_COUNTED_PROJECTS} live projects have a pending fleet ask; the tail is not counted`,
      );
    }
    return rows.slice(0, MAX_COUNTED_PROJECTS).map(({ projectId, slug, pending }) => ({ projectId, slug, pending }));
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
   * The rows of a `groupBy` read, with their slugs, in slug order. A project the lookup cannot answer
   * (gone from `Project`) is left out: a badge needs a slug to point at.
   */
  private async toPendingCounts(
    groups: Array<{ projectId: string | null; _count: { _all: number } }>,
  ): Promise<PendingCount[]> {
    const ids = groups.map((g) => g.projectId).filter((id): id is string => id !== null);
    // A caller with a global grant and no pending ask anywhere is the common case; without this it
    // would still ask Postgres for `id IN ()`.
    if (ids.length === 0) return [];
    const projects = await this.db.project.findMany({
      where: { id: { in: ids } }, select: { id: true, slug: true },
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
  pendingResolvedBy: model.pendingResolvedBy as ApprovalResolvedBy | null,
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

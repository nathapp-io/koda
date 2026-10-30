import { Inject, Injectable } from '@nestjs/common';
import { AbstractPrismaRepository, Paginate, PrismaService, type PrismaModelDelegate } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER, type IPageResult, type ITransactionManager } from '@nathapp/nestjs-data';
import { ValidationAppException, type IPageOption } from '@nathapp/nestjs-common';
import type { DecideScopes } from '../permissions/permission.service';
import type { PrincipalRef } from '../permissions/permissions.types';
import type { ApprovalRequestFilter, ApprovalRequestCounts } from './approval-request.queries';
import { visibleRequestWhere } from './approval-visibility';
import { Prisma, type ApprovalRequest, type ApprovalDecision, type PrismaClient } from '../generated/prisma/client';
import type { ApprovalDecisionRecord, ApprovalRequestRecord, ApprovalRequestStatus } from './domain/approval.domain';

export interface PendingApprovalMatch {
  actorType: ApprovalRequestRecord['actor']['type']; actorId: string;
  onBehalfOfType: 'USER' | 'AGENT' | null; onBehalfOfId: string | null;
  permissionKey: string; projectId: string | null; inputHash: string;
  /** The request's variant, or `null` for the key's primary command (a null column matches). */
  variant: string | null;
}
export type NewApprovalDecision = Omit<ApprovalDecisionRecord, 'id' | 'decidedAt' | 'comment' | 'params'> & {
  comment?: string | null; decidedAt?: Date; params?: unknown;
};

@Injectable()
export class PrismaApprovalRequestRepository extends AbstractPrismaRepository<ApprovalRequestRecord, ApprovalRequest, string> {
  constructor(@Inject(TRANSACTION_MANAGER) tx: ITransactionManager, private readonly prisma: PrismaService<PrismaClient>) { super(tx); }

  protected modelDelegate(client: unknown): PrismaModelDelegate<ApprovalRequest, string> {
    return (client as Record<string, unknown>).approvalRequest as PrismaModelDelegate<ApprovalRequest, string>;
  }
  protected toDomain(model: ApprovalRequest): ApprovalRequestRecord {
    const { actorType, actorId, onBehalfOfType, onBehalfOfId, variant, redeem, updatedAt: _updatedAt, ...fields } = model;
    return {
      ...fields,
      // Absent when the column is null (the key's primary command), so a record read back from the
      // database and one built in memory by the gate have the same shape.
      ...(variant !== null ? { variant } : {}),
      // Absent unless the column is true: a record never carries `redeem: false`, and every reader of
      // the flag tests for the property rather than its value.
      ...(redeem ? { redeem: true as const } : {}),
      actor: { type: actorType as ApprovalRequestRecord['actor']['type'], id: actorId },
      onBehalfOf: onBehalfOfType !== null && onBehalfOfId !== null
        ? { type: onBehalfOfType as 'USER' | 'AGENT', id: onBehalfOfId } : null,
    } as ApprovalRequestRecord;
  }
  protected toPersistenceCreate(record: ApprovalRequestRecord) {
    // An absent variant persists as NULL: the primary command's row. An absent redeem is the column's
    // false default, written explicitly so a create never depends on it.
    return { ...this.toPersistenceUpdate(record), variant: record.variant ?? null, redeem: record.redeem === true };
  }
  protected toPersistenceUpdate(patch: Partial<ApprovalRequestRecord>) {
    const { actor, onBehalfOf, input, result, ...fields } = patch;
    return {
      ...fields,
      ...(actor !== undefined ? { actorType: actor.type, actorId: actor.id } : {}),
      ...(onBehalfOf !== undefined ? { onBehalfOfType: onBehalfOf?.type ?? null, onBehalfOfId: onBehalfOf?.id ?? null } : {}),
      ...(input !== undefined ? { input: input === null ? Prisma.JsonNull : input as Prisma.InputJsonValue } : {}),
      ...(result !== undefined ? { result: result === null ? Prisma.DbNull : result as Prisma.InputJsonValue } : {}),
    };
  }

  /** Called only inside the execution transaction. A rename/reuse fails closed. */
  async lockProjectSlug(projectId: string, slug: string): Promise<void> {
    const rows = await this.prisma.client.$queryRaw<Array<{ slug: string }>>`
      SELECT "slug" FROM "Project" WHERE "id" = ${projectId} AND "deletedAt" IS NULL FOR UPDATE
    `;
    if (rows.length !== 1 || rows[0].slug !== slug) {
      throw new ValidationAppException({}, 'approvals.invalidInput');
    }
  }

  async findVisiblePage(
    visibility: { principal: PrincipalRef; scopes: DecideScopes },
    filter: ApprovalRequestFilter,
    page: IPageOption,
  ): Promise<IPageResult<ApprovalRequestRecord>> {
    const where = visibleRequestWhere(visibility, filter);
    const rows = await Paginate(this.prisma.client.approvalRequest, page, {
      where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.remap((row: ApprovalRequest) => this.toDomain(row));
  }

  async countVisiblePending(
    visibility: { principal: PrincipalRef; scopes: DecideScopes },
  ): Promise<Omit<ApprovalRequestCounts, 'total'>> {
    const groups = await this.prisma.client.approvalRequest.groupBy({
      by: ['projectId'], where: visibleRequestWhere(visibility, { status: 'pending' }), _count: { _all: true },
    });
    const projectIds = groups.flatMap(({ projectId }) => projectId === null ? [] : [projectId]);
    // Bounded by the distinct ids from the aggregate, including soft-deleted projects.
    const rows = projectIds.length === 0 ? [] : await this.prisma.client.project.findMany({
      where: { id: { in: projectIds } }, select: { id: true, slug: true }, take: projectIds.length,
    });
    const slugs = new Map(rows.map(({ id, slug }) => [id, slug]));
    const projects = groups.flatMap(({ projectId, _count }) => projectId === null ? [] : [{
      projectId, slug: slugs.get(projectId) ?? null, pending: _count._all,
    }]);
    projects.sort((a, b) => {
      if (a.slug === null && b.slug !== null) return 1;
      if (a.slug !== null && b.slug === null) return -1;
      return (a.slug ?? '').localeCompare(b.slug ?? '') || a.projectId.localeCompare(b.projectId);
    });
    return { unscoped: groups.find(({ projectId }) => projectId === null)?._count._all ?? 0, projects };
  }

  async lockById(id: string): Promise<ApprovalRequestRecord | null> {
    const rows = await this.prisma.client.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "ApprovalRequest" WHERE "id" = ${id} FOR UPDATE`;
    return rows.length === 0 ? null : this.findById(id);
  }

  /**
   * SELECT ... FOR UPDATE SKIP LOCKED; null when the row is missing or held by another transaction.
   *
   * A held row belongs to an in-flight decide or execute, so the caller must not wait for it: the
   * fleet takes the job or policy lock first, the opposite order to the engine's.
   */
  async lockByIdSkipLocked(id: string): Promise<ApprovalRequestRecord | null> {
    const rows = await this.prisma.client.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "ApprovalRequest" WHERE "id" = ${id} FOR UPDATE SKIP LOCKED`;
    return rows.length === 0 ? null : this.findById(id);
  }

  async findPendingDuplicate(match: PendingApprovalMatch, now: Date): Promise<ApprovalRequestRecord | null> {
    const row = await this.prisma.client.approvalRequest.findFirst({ where: { ...match, status: 'pending', expiresAt: { gt: now } }, orderBy: { createdAt: 'asc' } });
    return row ? this.toDomain(row) : null;
  }

  async findDue(now: Date, limit: number): Promise<ApprovalRequestRecord[]> {
    // Job-end cancellation owns ended-job asks, even past their deadline. A policy action's stamped close owns its ask
    // too (B2): expiring it would drop the resume's resolution, actor and outcome that the durable continuation replays.
    // Filter BEFORE LIMIT so a large cancellation backlog cannot starve unrelated timeouts. All joins use primary keys.
    const rows = await this.prisma.client.$queryRaw<ApprovalRequest[]>`
      SELECT r.* FROM "ApprovalRequest" r
      WHERE (r."status" = 'pending' OR (r."status" = 'approved' AND r."redeem")) AND r."expiresAt" <= ${now}
        AND NOT EXISTS (
          SELECT 1 FROM "FleetApprovalAsk" a JOIN "FleetJob" j ON j."id" = a."jobId"
          WHERE a."requestId" = r."id" AND a."kind" = 'bash' AND j."state" <> 'RUNNING'
        )
        AND NOT EXISTS (
          SELECT 1 FROM "FleetApprovalAsk" a
          WHERE a."requestId" = r."id" AND a."pendingClose" IS NOT NULL
        )
      ORDER BY r."expiresAt" ASC, r."id" ASC LIMIT ${limit}
    `;
    return rows.map((row) => this.toDomain(row));
  }

  /**
   * Recheck timeout ownership after locking the request; the due scan may predate a job's end or a policy action.
   * Lock order is request then job or policy, like execution. Job transitions skip held requests, so they can
   * commit while we wait for the job lock; we then see their committed state. Holding the job lock
   * until settlement also prevents a RUNNING check racing a subsequent transition.
   * No link (or a deleted job) retains normal engine expiry, as do budget and non-fleet requests.
   *
   * B2: a policy action stamps the close it intends on the ask while holding the policy lock, and the durable
   * continuation — not timeout policy — settles the asks carrying one. The policy is locked before that stamp is read
   * (the same order every fleet close takes), so a stamp that lands between the due scan and this recheck still wins and
   * the ask keeps its resume instead of expiring it away.
   */
  async canSettleTimeout(requestId: string): Promise<boolean> {
    await this.lockBudgetPolicyOf(requestId);
    if (await this.hasStampedClose(requestId)) return false;
    const jobs = await this.prisma.client.$queryRaw<Array<{ state: string }>>`
      SELECT j."state" FROM "FleetApprovalAsk" a JOIN "FleetJob" j ON j."id" = a."jobId"
      WHERE a."requestId" = ${requestId} AND a."kind" = 'bash'
      FOR UPDATE OF j
    `;
    return jobs.length === 0 || jobs[0]?.state === 'RUNNING';
  }

  /**
   * `FOR UPDATE` on the ask's budget policy, taken before its stamped close is read. A bash ask, a link without a
   * policy and a policy another transaction is deleting lock nothing: a deleted policy's stamp is already committed.
   */
  private async lockBudgetPolicyOf(requestId: string): Promise<void> {
    await this.prisma.client.$queryRaw<Array<{ id: string }>>`
      SELECT p."id" FROM "FleetApprovalAsk" a JOIN "BudgetPolicy" p ON p."id" = a."budgetPolicyId"
      WHERE a."requestId" = ${requestId} AND a."kind" = 'budget'
      FOR UPDATE OF p
    `;
  }

  /** Whether a policy action stamped the close it owes this ask (B2): its settlement belongs to the continuation. */
  private async hasStampedClose(requestId: string): Promise<boolean> {
    const link = await this.prisma.client.fleetApprovalAsk.findUnique({
      where: { requestId }, select: { pendingClose: true },
    });
    return link !== null && link.pendingClose !== null;
  }

  async findStaleApproved(before: Date, limit: number): Promise<ApprovalRequestRecord[]> {
    const rows = await this.prisma.client.approvalRequest.findMany({
      where: { status: 'approved', redeem: false, decidedAt: { lte: before } },
      orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }], take: limit,
    });
    return rows.map((row) => this.toDomain(row));
  }

  /** Caller owns the transaction, retaining the update lock through the subsequent read. */
  async transition(id: string, from: ApprovalRequestStatus, patch: Partial<ApprovalRequestRecord>): Promise<ApprovalRequestRecord | null> {
    const updated = await this.prisma.client.approvalRequest.updateMany({ where: { id, status: from }, data: this.toPersistenceUpdate(patch) });
    return updated.count === 0 ? null : this.findById(id);
  }

  async createDecision(input: NewApprovalDecision): Promise<ApprovalDecisionRecord> {
    const { params, ...fields } = input;
    // A `Json?` column takes `Prisma.DbNull` for "no value": a plain `null` is refused.
    const stored = params === null || params === undefined ? Prisma.DbNull : params as Prisma.InputJsonValue;
    return this.decisionToDomain(await this.prisma.client.approvalDecision.create({ data: { ...fields, params: stored } }));
  }

  async findDecisions(requestId: string): Promise<ApprovalDecisionRecord[]> {
    const rows = await this.prisma.client.approvalDecision.findMany({ where: { requestId }, orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }], take: 50 });
    return rows.map((row) => this.decisionToDomain(row));
  }
  private decisionToDomain(row: ApprovalDecision): ApprovalDecisionRecord {
    // A database NULL reads back as `params: null`, the shape the domain states for "no params".
    return { ...row, params: row.params ?? null } as ApprovalDecisionRecord;
  }
}

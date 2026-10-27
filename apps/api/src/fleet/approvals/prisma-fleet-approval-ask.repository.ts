import { Inject, Injectable } from '@nestjs/common';
import { AbstractPrismaRepository, PrismaService, type PrismaModelDelegate } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { Prisma, type FleetApprovalAsk as AskModel, type PrismaClient } from '../../generated/prisma/client';
import type { ApprovalRequestStatus } from '../../approvals/domain/approval.domain';
import type { ApprovalResolvedBy } from './domain/approval.domain';
import {
  FleetApprovalAskRecord, FleetAskKind, FleetAskWithStatus, IFleetApprovalAskRepository, MAX_PENDING_ASKS_PER_JOB,
  NewFleetApprovalAsk,
} from './domain/fleet-approval-ask.domain';

/** `outcome` is a JSON object in the domain and a `Json?` column in the row. */
const asObject = (value: Prisma.JsonValue | null): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const json = (value: Record<string, unknown>): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

/**
 * Permissions P3d-1 (US-009): the `FleetApprovalAsk` link table. Module-private — `ApprovalStoreModule`
 * provides it behind `FLEET_APPROVAL_ASK_REPOSITORY` and publishes `FleetApprovalAskStore` instead.
 */
@Injectable()
export class PrismaFleetApprovalAskRepository
  extends AbstractPrismaRepository<FleetApprovalAskRecord, AskModel, string>
  implements IFleetApprovalAskRepository {
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
    return {
      ...model,
      kind: model.kind as FleetAskKind,
      resolvedBy: model.resolvedBy as ApprovalResolvedBy | null,
      outcome: asObject(model.outcome),
    };
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
}

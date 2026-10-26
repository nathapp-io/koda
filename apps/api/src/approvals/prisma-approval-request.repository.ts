import { Inject, Injectable } from '@nestjs/common';
import { AbstractPrismaRepository, PrismaService, type PrismaModelDelegate } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { Prisma, type ApprovalRequest, type ApprovalDecision, type PrismaClient } from '../generated/prisma/client';
import type { ApprovalDecisionRecord, ApprovalRequestRecord, ApprovalRequestStatus } from './domain/approval.domain';

export interface PendingApprovalMatch {
  actorType: ApprovalRequestRecord['actor']['type']; actorId: string;
  onBehalfOfType: 'USER' | 'AGENT' | null; onBehalfOfId: string | null;
  permissionKey: string; projectId: string | null; inputHash: string;
}
export type NewApprovalDecision = Omit<ApprovalDecisionRecord, 'id' | 'decidedAt' | 'comment'> & { comment?: string | null; decidedAt?: Date };

@Injectable()
export class PrismaApprovalRequestRepository extends AbstractPrismaRepository<ApprovalRequestRecord, ApprovalRequest, string> {
  constructor(@Inject(TRANSACTION_MANAGER) tx: ITransactionManager, private readonly prisma: PrismaService<PrismaClient>) { super(tx); }

  protected modelDelegate(client: unknown): PrismaModelDelegate<ApprovalRequest, string> {
    return (client as Record<string, unknown>).approvalRequest as PrismaModelDelegate<ApprovalRequest, string>;
  }
  protected toDomain(model: ApprovalRequest): ApprovalRequestRecord {
    const { actorType, actorId, onBehalfOfType, onBehalfOfId, updatedAt: _updatedAt, ...fields } = model;
    return {
      ...fields,
      actor: { type: actorType as ApprovalRequestRecord['actor']['type'], id: actorId },
      onBehalfOf: onBehalfOfType !== null && onBehalfOfId !== null
        ? { type: onBehalfOfType as 'USER' | 'AGENT', id: onBehalfOfId } : null,
    } as ApprovalRequestRecord;
  }
  protected toPersistenceCreate(record: ApprovalRequestRecord) { return this.toPersistenceUpdate(record); }
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

  async lockById(id: string): Promise<ApprovalRequestRecord | null> {
    const rows = await this.prisma.client.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "ApprovalRequest" WHERE "id" = ${id} FOR UPDATE`;
    return rows.length === 0 ? null : this.findById(id);
  }

  async findPendingDuplicate(match: PendingApprovalMatch, now: Date): Promise<ApprovalRequestRecord | null> {
    const row = await this.prisma.client.approvalRequest.findFirst({ where: { ...match, status: 'pending', expiresAt: { gt: now } }, orderBy: { createdAt: 'asc' } });
    return row ? this.toDomain(row) : null;
  }

  async findDue(now: Date, limit: number): Promise<ApprovalRequestRecord[]> {
    const rows = await this.prisma.client.approvalRequest.findMany({
      where: { status: 'pending', expiresAt: { lte: now } }, orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }], take: limit,
    });
    return rows.map((row) => this.toDomain(row));
  }

  /** Caller owns the transaction, retaining the update lock through the subsequent read. */
  async transition(id: string, from: ApprovalRequestStatus, patch: Partial<ApprovalRequestRecord>): Promise<ApprovalRequestRecord | null> {
    const updated = await this.prisma.client.approvalRequest.updateMany({ where: { id, status: from }, data: this.toPersistenceUpdate(patch) });
    return updated.count === 0 ? null : this.findById(id);
  }

  async createDecision(input: NewApprovalDecision): Promise<ApprovalDecisionRecord> {
    return this.decisionToDomain(await this.prisma.client.approvalDecision.create({ data: input }));
  }

  async findDecisions(requestId: string): Promise<ApprovalDecisionRecord[]> {
    const rows = await this.prisma.client.approvalDecision.findMany({ where: { requestId }, orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }], take: 50 });
    return rows.map((row) => this.decisionToDomain(row));
  }
  private decisionToDomain(row: ApprovalDecision): ApprovalDecisionRecord { return { ...row } as ApprovalDecisionRecord; }
}

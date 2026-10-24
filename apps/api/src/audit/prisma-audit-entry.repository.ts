import { Inject, Injectable } from '@nestjs/common';
import { AbstractPrismaRepository, PrismaClientLike, PrismaModelDelegate, PrismaService, Paginate } from '@nathapp/nestjs-prisma';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult, ITransactionManager } from '@nathapp/nestjs-data';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { AuditEntry as AuditEntryModel, Prisma, PrismaClient } from '../generated/prisma/client';
import type { AuditEntryFilters, AuditEntryRecord } from './domain/audit-entry.domain';

@Injectable()
export class PrismaAuditEntryRepository extends AbstractPrismaRepository<AuditEntryRecord, AuditEntryModel, string> {
  constructor(@Inject(TRANSACTION_MANAGER) tx: ITransactionManager, private readonly prisma: PrismaService<PrismaClient>) { super(tx); }

  protected modelDelegate(client: PrismaClientLike): PrismaModelDelegate<AuditEntryModel, string> {
    return (client as unknown as PrismaClient).auditEntry as unknown as PrismaModelDelegate<AuditEntryModel, string>;
  }
  protected toDomain(m: AuditEntryModel): AuditEntryRecord {
    return { ...m } as AuditEntryRecord;
  }
  protected toPersistenceCreate(d: AuditEntryRecord) {
    return {
      key: d.key, resourceType: d.resourceType, resourceId: d.resourceId, projectId: d.projectId,
      actorType: d.actorType, actorId: d.actorId, onBehalfOfType: d.onBehalfOfType, onBehalfOfId: d.onBehalfOfId,
      origin: d.origin, requiredMode: d.requiredMode, satisfiedBy: d.satisfiedBy, approverType: d.approverType,
      approverId: d.approverId, approvalRequestId: d.approvalRequestId, correlationId: d.correlationId,
      summary: d.summary, createdAt: d.createdAt,
    };
  }
  protected toPersistenceUpdate(): never { throw new Error('audit entries are append-only'); }

  async findPage(filters: AuditEntryFilters, page: IPageOption): Promise<IPageResult<AuditEntryRecord>> {
    const where: Prisma.AuditEntryWhereInput = {
      ...(filters.key !== undefined ? { key: filters.key } : {}),
      ...(filters.actorType !== undefined ? { actorType: filters.actorType } : {}),
      ...(filters.actorId !== undefined ? { actorId: filters.actorId } : {}),
      ...(filters.approverId !== undefined ? { approverId: filters.approverId } : {}),
      ...(filters.projectId !== undefined ? { projectId: filters.projectId } : {}),
      ...(filters.resourceType !== undefined ? { resourceType: filters.resourceType } : {}),
      ...(filters.resourceId !== undefined ? { resourceId: filters.resourceId } : {}),
      ...((filters.from !== undefined || filters.to !== undefined) ? { createdAt: {
        ...(filters.from !== undefined ? { gte: filters.from } : {}),
        ...(filters.to !== undefined ? { lte: filters.to } : {}),
      } } : {}),
    };
    const rows = await Paginate(this.prisma.client.auditEntry, page, { where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return rows.remap((m: AuditEntryModel) => this.toDomain(m));
  }
}

import { Injectable, Inject } from '@nestjs/common';
import { AbstractPrismaRepository, PrismaClientLike, PrismaModelDelegate, PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { MemoryItem as MemoryItemModel, PrismaClient } from '@prisma/client';
import {
  MemoryQuery,
  ProjectMemoryQuery,
  PaginatedResult,
  MemoryItemInput,
  MemoryItem,
} from './memory-item-repository';

export function buildActiveKey(_projectId: string, kind: string, subject: string, predicate: string): string {
  return `${kind}:${subject}:${predicate}`;
}

@Injectable()
export class PrismaMemoryItemRepository
  extends AbstractPrismaRepository<MemoryItem, MemoryItemModel, string> {
  constructor(
    @Inject(TRANSACTION_MANAGER) tx: ITransactionManager,
    private readonly prisma: PrismaService<PrismaClient>,
  ) {
    super(tx);
  }

  protected modelDelegate(client: PrismaClientLike): PrismaModelDelegate<MemoryItemModel, string> {
    return (client as unknown as PrismaClient).memoryItem as unknown as PrismaModelDelegate<MemoryItemModel, string>;
  }

  protected toDomain(m: MemoryItemModel): MemoryItem {
    return {
      id: m.id,
      projectId: m.projectId,
      kind: m.kind,
      subject: m.subject,
      predicate: m.predicate,
      object: m.object ?? undefined,
      activeKey: m.activeKey ?? undefined,
      ownerId: m.ownerId ?? undefined,
      sourceType: m.sourceType ?? undefined,
      sourceId: m.sourceId ?? undefined,
      status: m.status,
      confidence: m.confidence,
      ttlAt: m.ttlAt ?? undefined,
      supersededBy: m.supersededBy ?? undefined,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      deletedAt: m.deletedAt ?? undefined,
    };
  }

  protected toPersistenceCreate(domain: MemoryItem): Omit<MemoryItemModel, 'id' | 'createdAt' | 'updatedAt'> {
    return {
      projectId: domain.projectId,
      kind: domain.kind,
      subject: domain.subject,
      predicate: domain.predicate,
      object: domain.object ?? null,
      activeKey: domain.activeKey ?? null,
      ownerId: domain.ownerId ?? null,
      sourceType: domain.sourceType ?? null,
      sourceId: domain.sourceId ?? null,
      status: domain.status,
      confidence: domain.confidence,
      ttlAt: domain.ttlAt ?? null,
      supersededBy: domain.supersededBy ?? null,
      deletedAt: domain.deletedAt ?? null,
    };
  }

  protected toPersistenceUpdate(patch: Partial<MemoryItem>): Partial<Omit<MemoryItemModel, 'id' | 'createdAt' | 'updatedAt'>> {
    const data: Partial<Omit<MemoryItemModel, 'id' | 'createdAt' | 'updatedAt'>> = {};
    if (patch.projectId !== undefined) data.projectId = patch.projectId;
    if (patch.kind !== undefined) data.kind = patch.kind;
    if (patch.subject !== undefined) data.subject = patch.subject;
    if (patch.predicate !== undefined) data.predicate = patch.predicate;
    if (patch.object !== undefined) data.object = patch.object ?? null;
    if (patch.activeKey !== undefined) data.activeKey = patch.activeKey ?? null;
    if (patch.ownerId !== undefined) data.ownerId = patch.ownerId ?? null;
    if (patch.sourceType !== undefined) data.sourceType = patch.sourceType ?? null;
    if (patch.sourceId !== undefined) data.sourceId = patch.sourceId ?? null;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.confidence !== undefined) data.confidence = patch.confidence;
    if (patch.ttlAt !== undefined) data.ttlAt = patch.ttlAt ?? null;
    if (patch.supersededBy !== undefined) data.supersededBy = patch.supersededBy ?? null;
    if (patch.deletedAt !== undefined) data.deletedAt = patch.deletedAt ?? null;
    return data;
  }

  async findByProject(query: MemoryQuery): Promise<PaginatedResult<MemoryItem>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {
      projectId: query.projectId,
      deletedAt: null,
      status: query.status ?? 'active',
    };
    if (query.kind) where.kind = query.kind;
    if (query.subject) where.subject = query.subject;
    if (query.predicate) where.predicate = query.predicate;
    if (query.activeKey !== undefined) where.activeKey = query.activeKey;
    if (query.sourceType) where.sourceType = query.sourceType;
    if (query.sourceId) where.sourceId = query.sourceId;

    const [models, total] = await Promise.all([
      this.prisma.client.memoryItem.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
      this.prisma.client.memoryItem.count({ where }),
    ]);

    return { data: models.map((m) => this.toDomain(m)), total, page, limit };
  }

  async upsert(item: MemoryItemInput): Promise<MemoryItem> {
    return this.prisma.client.$transaction(
      async (client) => {
        const db = client as unknown as PrismaClient;

        const activeKey = buildActiveKey(item.projectId, item.kind, item.subject, item.predicate);

        const existingActive = await db.memoryItem.findFirst({
          where: {
            projectId: item.projectId,
            kind: item.kind,
            subject: item.subject,
            predicate: item.predicate,
            activeKey: { not: null },
            deletedAt: null,
          },
        });

        if (existingActive) {
          await db.memoryItem.update({
            where: { id: existingActive.id },
            data: { activeKey: null, status: 'superseded', supersededBy: undefined },
          });
        }

        const created = await db.memoryItem.create({
          data: {
            projectId: item.projectId,
            kind: item.kind,
            subject: item.subject,
            predicate: item.predicate,
            object: item.object,
            activeKey,
            ownerId: item.ownerId,
            sourceType: item.sourceType,
            sourceId: item.sourceId,
            status: item.status ?? 'active',
            confidence: item.confidence ?? 0.8,
            ttlAt: item.ttlAt ?? null,
            supersededBy: item.supersededBy,
          },
        });

        return this.toDomain(created);
      },
      { isolationLevel: 'Serializable' },
    );
  }

  async findActive(
    projectId: string,
    kind: string,
    subject: string,
    predicate: string,
  ): Promise<MemoryItem | null> {
    const m = await this.prisma.client.memoryItem.findFirst({
      where: { projectId, kind, subject, predicate, activeKey: { not: null }, status: 'active', deletedAt: null },
    });
    return m ? this.toDomain(m) : null;
  }

  async reject(id: string): Promise<void> {
    await this.prisma.client.memoryItem.update({
      where: { id },
      data: { activeKey: null, status: 'rejected' },
    });
  }

  async softDelete(id: string): Promise<void> {
    await this.prisma.client.memoryItem.update({
      where: { id },
      data: { deletedAt: new Date(), activeKey: null },
    });
  }

  async updateDirect(id: string, data: Partial<MemoryItemInput>): Promise<void> {
    const updateData: Record<string, unknown> = {};
    if (data.status !== undefined) updateData.status = data.status;
    if (data.confidence !== undefined) updateData.confidence = data.confidence;
    if (data.activeKey !== undefined) updateData.activeKey = data.activeKey;
    if (data.supersededBy !== undefined) updateData.supersededBy = data.supersededBy;
    if (data.ttlAt !== undefined) updateData.ttlAt = data.ttlAt;

    await this.prisma.client.memoryItem.update({ where: { id }, data: updateData });
  }

  async findByProjectMemory(query: ProjectMemoryQuery): Promise<{ items: MemoryItem[]; total: number }> {
    const limit = Math.min(query.limit ?? 10, 50);
    let page = query.page ?? 1;
    if (page < 1) page = 1;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = { projectId: query.projectId, deletedAt: null };

    if (query.status) {
      where.status = query.status;
    } else {
      where.status = 'active';
      const now = new Date();
      where.OR = [
        { ttlAt: null },
        { ttlAt: { gt: now } },
      ];
    }

    if (query.kind) where.kind = query.kind;
    if (query.subject && query.subject.trim().length > 0) where.subject = { startsWith: query.subject };

    const orderByField = query.orderBy ?? 'confidence';
    const orderByClause: Record<string, 'asc' | 'desc'>[] = [];
    if (orderByField === 'confidence') {
      orderByClause.push({ confidence: 'desc' }, { updatedAt: 'desc' }, { createdAt: 'desc' });
    } else if (orderByField === 'updatedAt') {
      orderByClause.push({ updatedAt: 'desc' }, { confidence: 'desc' }, { createdAt: 'desc' });
    } else {
      orderByClause.push({ createdAt: 'desc' }, { confidence: 'desc' }, { updatedAt: 'desc' });
    }

    const [models, total] = await Promise.all([
      this.prisma.client.memoryItem.findMany({ where, skip, take: limit, orderBy: orderByClause }),
      this.prisma.client.memoryItem.count({ where }),
    ]);

    return { items: models.map((m) => this.toDomain(m)), total };
  }
}

import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
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
export class PrismaMemoryItemRepository {
  constructor(private readonly prisma: PrismaService) {}

  private get db() {
    return this.prisma.client as unknown as {
      memoryItem: {
        findMany(options: unknown): Promise<MemoryItem[]>;
        findUnique(options: unknown): Promise<MemoryItem | null>;
        findFirst(options: unknown): Promise<MemoryItem | null>;
        create(options: unknown): Promise<MemoryItem>;
        update(options: unknown): Promise<MemoryItem>;
        count(options: unknown): Promise<number>;
      };
      $transaction<T>(fn: (client: unknown) => Promise<T>, options?: { isolationLevel: 'Serializable' }): Promise<T>;
    };
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

    const [data, total] = await Promise.all([
      this.db.memoryItem.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
      this.db.memoryItem.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async upsert(item: MemoryItemInput): Promise<MemoryItem> {
    return this.db.$transaction(
      async (client) => {
        const db = client as unknown as {
          memoryItem: {
            findFirst(options: unknown): Promise<MemoryItem | null>;
            create(options: unknown): Promise<MemoryItem>;
            update(options: unknown): Promise<MemoryItem>;
          };
        };

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

        return db.memoryItem.create({
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
    return this.db.memoryItem.findFirst({
      where: { projectId, kind, subject, predicate, activeKey: { not: null }, status: 'active', deletedAt: null },
    });
  }

  async reject(id: string): Promise<void> {
    await this.db.memoryItem.update({
      where: { id },
      data: { activeKey: null, status: 'rejected' },
    });
  }

  async softDelete(id: string): Promise<void> {
    await this.db.memoryItem.update({
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

    await this.db.memoryItem.update({ where: { id }, data: updateData });
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

    const [items, total] = await Promise.all([
      this.db.memoryItem.findMany({ where, skip, take: limit, orderBy: orderByClause }),
      this.db.memoryItem.count({ where }),
    ]);

    return { items, total };
  }
}

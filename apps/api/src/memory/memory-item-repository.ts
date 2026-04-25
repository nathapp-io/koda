import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { MemoryKind } from '../common/enums';

export interface MemoryQuery {
  projectId: string;
  kind?: MemoryKind;
  subject?: string;
  predicate?: string;
  activeKey?: string;
  sourceType?: string;
  sourceId?: string;
  status?: string;
  page?: number;
  limit?: number;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export interface MemoryItemInput {
  id?: string;
  projectId: string;
  kind: MemoryKind;
  subject: string;
  predicate: string;
  object?: string;
  activeKey?: string | null;
  sourceType?: string;
  sourceId?: string;
  status?: string;
  confidence?: number;
  ttlAt?: Date | null;
  supersededBy?: string | null;
  deletedAt?: Date | null;
}

export interface MemoryItem {
  id: string;
  projectId: string;
  kind: string;
  subject: string;
  predicate: string;
  object?: string;
  activeKey?: string;
  sourceType?: string;
  sourceId?: string;
  status?: string;
  confidence?: number;
  ttlAt?: Date;
  supersededBy?: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
}

@Injectable()
export class MemoryItemRepository {
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

    const where: Record<string, unknown> = { projectId: query.projectId, deletedAt: null };
    if (query.kind) where.kind = query.kind;
    if (query.subject) where.subject = query.subject;
    if (query.predicate) where.predicate = query.predicate;
    if (query.activeKey !== undefined) where.activeKey = query.activeKey;
    if (query.sourceType) where.sourceType = query.sourceType;
    if (query.sourceId) where.sourceId = query.sourceId;
    if (query.status) where.status = query.status;

    const [data, total] = await Promise.all([
      this.db.memoryItem.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
      this.db.memoryItem.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async upsert(item: MemoryItemInput): Promise<MemoryItem> {
    const memoryId = item.id ?? `mem-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    return this.db.$transaction(
      async (client) => {
        const db = client as unknown as {
          memoryItem: {
            findFirst(options: unknown): Promise<MemoryItem | null>;
            create(options: unknown): Promise<MemoryItem>;
            update(options: unknown): Promise<MemoryItem>;
          };
        };

        if (item.activeKey) {
          const existingActive = await db.memoryItem.findFirst({
            where: {
              projectId: item.projectId,
              kind: item.kind,
              subject: item.subject,
              predicate: item.predicate,
              activeKey: { not: null },
              deletedAt: null,
              id: { not: item.id ?? undefined },
            },
          });

          if (existingActive) {
            await db.memoryItem.update({
              where: { id: existingActive.id },
              data: { activeKey: null, status: 'superseded', supersededBy: memoryId },
            });
          }
        }

        if (item.id) {
          return db.memoryItem.update({ where: { id: item.id }, data: { ...item, id: memoryId } });
        }

        return db.memoryItem.create({ data: { ...item, id: memoryId } });
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
      where: { projectId, kind, subject, predicate, activeKey: { not: null }, deletedAt: null },
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
}
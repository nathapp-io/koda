import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';

const MemoryKind = {
  FACT: 'FACT',
  INCIDENT_PATTERN: 'INCIDENT_PATTERN',
  DECISION: 'DECISION',
} as const;
type MemoryKind = (typeof MemoryKind)[keyof typeof MemoryKind];

interface MemoryItem {
  id: string;
  projectId: string;
  kind: MemoryKind;
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

interface MemoryQuery {
  projectId: string;
  kind?: MemoryKind;
  subject?: string;
  predicate?: string;
  activeKey?: string;
  sourceType?: string;
  sourceId?: string;
  page?: number;
  limit?: number;
}

interface PaginatedResult {
  data: MemoryItem[];
  total: number;
  page: number;
  limit: number;
}

interface MemoryItemInput {
  id?: string;
  projectId: string;
  kind: MemoryKind;
  subject: string;
  predicate: string;
  object?: string;
  sourceType?: string;
  sourceId?: string;
  status?: string;
  confidence?: number;
}

interface MemoryItemRepository {
  findByProject(query: MemoryQuery): Promise<PaginatedResult>;
  upsert(item: MemoryItemInput): Promise<MemoryItem>;
  findActive(projectId: string, kind: string, subject: string, predicate: string): Promise<MemoryItem | null>;
  reject(id: string): Promise<void>;
  softDelete(id: string): Promise<void>;
}

function createMemoryItemRepository(prisma: any): MemoryItemRepository {
  return {
    async findByProject(query: MemoryQuery) {
      const page = query.page ?? 1;
      const limit = query.limit ?? 20;
      const skip = (page - 1) * limit;

      const where: any = { projectId: query.projectId, deletedAt: null };
      if (query.kind) where.kind = query.kind;
      if (query.subject) where.subject = query.subject;
      if (query.predicate) where.predicate = query.predicate;
      if (query.activeKey !== undefined) where.activeKey = query.activeKey;
      if (query.sourceType) where.sourceType = query.sourceType;
      if (query.sourceId) where.sourceId = query.sourceId;

      const [data, total] = await Promise.all([
        prisma.client.memoryItem.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
        prisma.client.memoryItem.count({ where }),
      ]);

      return { data, total, page, limit };
    },

    async upsert(item: MemoryItemInput) {
      if (item.id) {
        return prisma.client.memoryItem.update({ where: { id: item.id }, data: item });
      }
      return prisma.client.memoryItem.create({ data: item });
    },

    async findActive(projectId: string, kind: string, subject: string, predicate: string) {
      return prisma.client.memoryItem.findFirst({
        where: { projectId, kind, subject, predicate, activeKey: { not: null }, deletedAt: null },
      });
    },

    async reject(id: string) {
      return prisma.client.memoryItem.update({ where: { id }, data: { activeKey: null, status: 'rejected' } });
    },

    async softDelete(id: string) {
      return prisma.client.memoryItem.update({ where: { id }, data: { deletedAt: new Date(), activeKey: null } });
    },
  };
}

describe('MemoryItemRepository', () => {
  let repository: MemoryItemRepository;
  let prismaService: PrismaService<any>;

  const mockPrismaClient = {
    memoryItem: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const mockPrismaService = {
    client: mockPrismaClient,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: 'MemoryItemRepository',
          useFactory: () => createMemoryItemRepository(mockPrismaService),
        },
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    repository = module.get<MemoryItemRepository>('MemoryItemRepository');
    prismaService = module.get<PrismaService<any>>(PrismaService);

    jest.clearAllMocks();
  });

  describe('findByProject', () => {
    const baseQuery: MemoryQuery = { projectId: 'project-123' };

    it('should return paginated results with default page=1 limit=20', async () => {
      const mockItems: MemoryItem[] = [
        { id: '1', projectId: 'project-123', kind: 'FACT', subject: 'ticket:1', predicate: 'status', createdAt: new Date(), updatedAt: new Date() },
      ];
      mockPrismaClient.memoryItem.findMany.mockResolvedValue(mockItems);
      mockPrismaClient.memoryItem.count.mockResolvedValue(1);

      const result = await repository.findByProject(baseQuery);

      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(result.total).toBe(1);
      expect(result.data).toHaveLength(1);
    });

    it('should filter by kind when provided', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProject({ ...baseQuery, kind: 'FACT' });

      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ kind: 'FACT' }),
        }),
      );
    });

    it('should filter by subject when provided', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProject({ ...baseQuery, subject: 'ticket:123' });

      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ subject: 'ticket:123' }),
        }),
      );
    });

    it('should filter by predicate when provided', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProject({ ...baseQuery, predicate: 'status' });

      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ predicate: 'status' }),
        }),
      );
    });

    it('should filter by activeKey when provided', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProject({ ...baseQuery, activeKey: 'some-key' });

      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ activeKey: 'some-key' }),
        }),
      );
    });

    it('should filter by sourceType and sourceId when provided', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProject({ ...baseQuery, sourceType: 'TicketEvent', sourceId: 'event-123' });

      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ sourceType: 'TicketEvent', sourceId: 'event-123' }),
        }),
      );
    });

    it('should respect page and limit parameters', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProject({ ...baseQuery, page: 3, limit: 10 });

      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 20,
          take: 10,
        }),
      );
    });

    it('should exclude soft-deleted rows (deletedAt IS NOT NULL)', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProject(baseQuery);

      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ deletedAt: null }),
        }),
      );
    });
  });

  describe('findActive', () => {
    it('should return MemoryItem where activeKey IS NOT NULL', async () => {
      const mockItem: MemoryItem = {
        id: 'mem-1',
        projectId: 'project-123',
        kind: 'FACT',
        subject: 'ticket:1',
        predicate: 'status',
        activeKey: 'active-key-uuid',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockPrismaClient.memoryItem.findFirst.mockResolvedValue(mockItem);

      const result = await repository.findActive('project-123', 'FACT', 'ticket:1', 'status');

      expect(result).toEqual(mockItem);
      expect(mockPrismaClient.memoryItem.findFirst).toHaveBeenCalledWith({
        where: { projectId: 'project-123', kind: 'FACT', subject: 'ticket:1', predicate: 'status', activeKey: { not: null }, deletedAt: null },
      });
    });

    it('should return null when no active memory exists', async () => {
      mockPrismaClient.memoryItem.findFirst.mockResolvedValue(null);

      const result = await repository.findActive('project-123', 'FACT', 'ticket:1', 'status');

      expect(result).toBeNull();
    });

    it('should not include soft-deleted rows', async () => {
      mockPrismaClient.memoryItem.findFirst.mockResolvedValue(null);

      await repository.findActive('project-123', 'FACT', 'ticket:1', 'status');

      expect(mockPrismaClient.memoryItem.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ deletedAt: null }),
        }),
      );
    });
  });

  describe('upsert', () => {
    it('should insert MemoryItem when id is not provided', async () => {
      const input: MemoryItemInput = {
        projectId: 'project-123',
        kind: 'FACT',
        subject: 'ticket:1',
        predicate: 'status',
        object: 'IN_PROGRESS',
      };
      const created: MemoryItem = { id: 'mem-new', ...input, createdAt: new Date(), updatedAt: new Date() };
      mockPrismaClient.memoryItem.create.mockResolvedValue(created);

      const result = await repository.upsert(input);

      expect(result.id).toBe('mem-new');
      expect(mockPrismaClient.memoryItem.create).toHaveBeenCalledWith({ data: input });
    });

    it('should update MemoryItem when id is provided', async () => {
      const input: MemoryItemInput = {
        id: 'mem-1',
        projectId: 'project-123',
        kind: 'FACT',
        subject: 'ticket:1',
        predicate: 'status',
        object: 'CLOSED',
      };
      const updated: MemoryItem = { id: 'mem-1', ...input, updatedAt: new Date(), createdAt: new Date() };
      mockPrismaClient.memoryItem.update.mockResolvedValue(updated);

      const result = await repository.upsert(input);

      expect(mockPrismaClient.memoryItem.update).toHaveBeenCalledWith({ where: { id: 'mem-1' }, data: input });
    });

    it('should set sourceType and sourceId when provided', async () => {
      const input: MemoryItemInput = {
        projectId: 'project-123',
        kind: 'FACT',
        subject: 'ticket:1',
        predicate: 'status',
        sourceType: 'TicketEvent',
        sourceId: 'event-456',
      };
      const created: MemoryItem = { id: 'mem-new', ...input, createdAt: new Date(), updatedAt: new Date() };
      mockPrismaClient.memoryItem.create.mockResolvedValue(created);

      const result = await repository.upsert(input);

      expect(mockPrismaClient.memoryItem.create).toHaveBeenCalledWith({ data: input });
    });
  });

  describe('reject', () => {
    it('should set activeKey to NULL and status to rejected', async () => {
      mockPrismaClient.memoryItem.update.mockResolvedValue({ id: 'mem-1', activeKey: null, status: 'rejected' });

      await repository.reject('mem-1');

      expect(mockPrismaClient.memoryItem.update).toHaveBeenCalledWith({
        where: { id: 'mem-1' },
        data: { activeKey: null, status: 'rejected' },
      });
    });
  });

  describe('softDelete', () => {
    it('should set deletedAt and activeKey to null', async () => {
      mockPrismaClient.memoryItem.update.mockResolvedValue({ id: 'mem-1', deletedAt: new Date(), activeKey: null });

      await repository.softDelete('mem-1');

      expect(mockPrismaClient.memoryItem.update).toHaveBeenCalledWith({
        where: { id: 'mem-1' },
        data: { deletedAt: expect.any(Date), activeKey: null },
      });
    });
  });
});

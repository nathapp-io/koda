import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { MemoryItemRepository } from './memory-item-repository';

const MemoryKind = {
  FACT: 'FACT',
  INCIDENT_PATTERN: 'INCIDENT_PATTERN',
  DECISION: 'DECISION',
} as const;
type MemoryKind = (typeof MemoryKind)[keyof typeof MemoryKind];

describe('MemoryItemRepository.findByProjectMemory', () => {
  let repository: MemoryItemRepository;
  let prismaService: PrismaService<any>;

  const mockPrismaClient = {
    memoryItem: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  };

  const mockPrismaService = {
    client: mockPrismaClient,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryItemRepository,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    repository = module.get<MemoryItemRepository>(MemoryItemRepository);
    prismaService = module.get<PrismaService<any>>(PrismaService);

    jest.clearAllMocks();
  });

  describe('default active filter', () => {
    it('defaults to status=active and ttlAt=null when no status provided', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory({ projectId: 'project-123' });

      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            projectId: 'project-123',
            deletedAt: null,
            status: 'active',
            ttlAt: { equals: null },
          }),
        }),
      );
    });
  });

  describe('kind filter', () => {
    it('should filter by kind when provided', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory({ projectId: 'project-123', kind: MemoryKind.FACT });

      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ kind: 'FACT' }),
        }),
      );
    });
  });

  describe('subject prefix filter', () => {
    it('should use startsWith for subject prefix matching', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory({ projectId: 'project-123', subject: 'ticket:123' });

      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            subject: { startsWith: 'ticket:123' },
          }),
        }),
      );
    });
  });

  describe('status=superseded includes supersededBy', () => {
    it('should not override status when explicitly provided', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory({ projectId: 'project-123', status: 'superseded' });

      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'superseded' }),
        }),
      );
    });
  });

  describe('ttlAt null exclusion', () => {
    it('always filters out expired memories with ttlAt not null', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory({ projectId: 'project-123', status: 'superseded' });

      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ ttlAt: { equals: null } }),
        }),
      );
    });
  });

  describe('ordering variants', () => {
    it('should order by confidence desc, updatedAt desc, createdAt desc by default', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory({ projectId: 'project-123' });

      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [
            { confidence: 'desc' },
            { updatedAt: 'desc' },
            { createdAt: 'desc' },
          ],
        }),
      );
    });

    it('should support updatedAt ordering', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory({ projectId: 'project-123', orderBy: 'updatedAt' });

      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [
            { updatedAt: 'desc' },
            { confidence: 'desc' },
            { createdAt: 'desc' },
          ],
        }),
      );
    });

    it('should support createdAt ordering', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory({ projectId: 'project-123', orderBy: 'createdAt' });

      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [
            { createdAt: 'desc' },
            { confidence: 'desc' },
            { updatedAt: 'desc' },
          ],
        }),
      );
    });
  });

  describe('pagination', () => {
    it('should use default page=1 limit=20', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory({ projectId: 'project-123' });

      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 0,
          take: 20,
        }),
      );
    });

    it('should calculate skip correctly for page 3 with limit 10', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory({ projectId: 'project-123', page: 3, limit: 10 });

      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 20,
          take: 10,
        }),
      );
    });
  });

  describe('return shape', () => {
    it('should return { items, total } not paginated result', async () => {
      const mockItems = [
        { id: 'mem-1', projectId: 'project-123', kind: 'FACT', subject: 'ticket:1', predicate: 'status', createdAt: new Date(), updatedAt: new Date() },
      ];
      mockPrismaClient.memoryItem.findMany.mockResolvedValue(mockItems);
      mockPrismaClient.memoryItem.count.mockResolvedValue(1);

      const result = await repository.findByProjectMemory({ projectId: 'project-123' });

      expect(result).toHaveProperty('items');
      expect(result).toHaveProperty('total');
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });
});
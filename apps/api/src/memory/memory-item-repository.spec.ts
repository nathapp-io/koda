import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaMemoryItemRepository } from './prisma-memory-item.repository';

describe('PrismaMemoryItemRepository.findByProjectMemory', () => {
  let repository: PrismaMemoryItemRepository;
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
        PrismaMemoryItemRepository,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    repository = module.get<PrismaMemoryItemRepository>(PrismaMemoryItemRepository);
    prismaService = module.get<PrismaService<any>>(PrismaService);

    jest.clearAllMocks();
  });

  describe('default active filter', () => {
    it('defaults to status=active and includes non-expired TTL items when no status provided', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory({ projectId: 'project-123' });

      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            projectId: 'project-123',
            deletedAt: null,
            status: 'active',
            OR: [
              { ttlAt: null },
              { ttlAt: { gt: expect.any(Date) } },
            ],
          }),
        }),
      );
    });
  });

  describe('kind filter', () => {
    it('should filter by kind when provided', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory({ projectId: 'project-123', kind: 'FACT' });

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
    it('should not add TTL filter when status is explicitly provided', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory({ projectId: 'project-123', status: 'superseded' });

      const callArgs = mockPrismaClient.memoryItem.findMany.mock.calls[0][0] as Record<string, unknown>;
      const where = callArgs.where as Record<string, unknown>;
      expect(where.status).toBe('superseded');
      expect(where.OR).toBeUndefined();
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
    it('should use limit cap of 10 by default', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory({ projectId: 'project-123' });

      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 0,
          take: 10,
        }),
      );
    });

    it('should calculate skip correctly for page 3 with limit 5', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory({ projectId: 'project-123', page: 3, limit: 5 });

      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 10,
          take: 5,
        }),
      );
    });
  });

  describe('return shape', () => {
    it('should return { items, total }', async () => {
      const mockItems = [
        { id: 'mem-1', projectId: 'project-123', kind: 'FACT', subject: 'ticket:1', predicate: 'status', confidence: 0.9, status: 'active', createdAt: new Date(), updatedAt: new Date() },
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
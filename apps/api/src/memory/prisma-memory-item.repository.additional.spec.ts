import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaMemoryItemRepository, buildActiveKey } from './prisma-memory-item.repository';
import { MemoryKind } from '../common/enums';

const makeModelRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'mem-1',
  projectId: 'project-123',
  kind: 'FACT',
  subject: 'ticket:1',
  predicate: 'status',
  object: 'active',
  activeKey: 'FACT:ticket:1:status',
  ownerId: 'user-1',
  sourceType: 'ticket_event',
  sourceId: 'evt-1',
  status: 'active',
  confidence: 0.9,
  ttlAt: null,
  supersededBy: null,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('buildActiveKey', () => {
  it('generates activeKey ignoring projectId', () => {
    const key = buildActiveKey('project-123', 'FACT', 'ticket:1', 'status');
    expect(key).toBe('FACT:ticket:1:status');
  });
});

describe('PrismaMemoryItemRepository (additional coverage)', () => {
  let repository: PrismaMemoryItemRepository;

  const mockMemoryItem = {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };

  const mockTransaction = jest.fn();

  const mockPrismaClient = {
    memoryItem: mockMemoryItem,
    $transaction: mockTransaction,
  };

  const mockPrismaService = {
    client: mockPrismaClient,
  };

  const mockTransactionManager = {
    run: jest.fn((fn: () => Promise<unknown>) => fn()),
    getClient: jest.fn(),
    isInTransaction: jest.fn(() => false),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrismaMemoryItemRepository,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: TRANSACTION_MANAGER, useValue: mockTransactionManager },
      ],
    }).compile();

    repository = module.get<PrismaMemoryItemRepository>(PrismaMemoryItemRepository);

    jest.clearAllMocks();
  });

  describe('findByProject', () => {
    it('uses default page=1 and limit=20 when not provided', async () => {
      mockMemoryItem.findMany.mockResolvedValue([]);
      mockMemoryItem.count.mockResolvedValue(0);

      await repository.findByProject({ projectId: 'project-123' });

      expect(mockMemoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 }),
      );
    });

    it('filters by kind, subject, predicate when provided', async () => {
      mockMemoryItem.findMany.mockResolvedValue([]);
      mockMemoryItem.count.mockResolvedValue(0);

      await repository.findByProject({
        projectId: 'project-123',
        kind: MemoryKind.FACT,
        subject: 'ticket:1',
        predicate: 'status',
      });

      expect(mockMemoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            kind: MemoryKind.FACT,
            subject: 'ticket:1',
            predicate: 'status',
          }),
        }),
      );
    });

    it('returns paginated result shape with data, total, page, limit', async () => {
      const rows = [makeModelRow()];
      mockMemoryItem.findMany.mockResolvedValue(rows);
      mockMemoryItem.count.mockResolvedValue(1);

      const result = await repository.findByProject({ projectId: 'project-123' });

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('total', 1);
      expect(result).toHaveProperty('page', 1);
      expect(result).toHaveProperty('limit', 20);
      expect(result.data).toHaveLength(1);
    });

    it('maps null fields to undefined in domain object', async () => {
      const row = makeModelRow({ object: null, ownerId: null, activeKey: null, deletedAt: null });
      mockMemoryItem.findMany.mockResolvedValue([row]);
      mockMemoryItem.count.mockResolvedValue(1);

      const result = await repository.findByProject({ projectId: 'project-123' });
      const item = result.data[0];

      expect(item.object).toBeUndefined();
      expect(item.ownerId).toBeUndefined();
      expect(item.activeKey).toBeUndefined();
      expect(item.deletedAt).toBeUndefined();
    });
  });

  describe('findActive', () => {
    it('returns null when no active item exists', async () => {
      mockMemoryItem.findFirst.mockResolvedValue(null);

      const result = await repository.findActive('project-123', 'FACT', 'ticket:1', 'status');

      expect(result).toBeNull();
    });

    it('returns mapped domain item when active item exists', async () => {
      const row = makeModelRow();
      mockMemoryItem.findFirst.mockResolvedValue(row);

      const result = await repository.findActive('project-123', 'FACT', 'ticket:1', 'status');

      expect(result).not.toBeNull();
      expect(result?.id).toBe('mem-1');
      expect(mockMemoryItem.findFirst).toHaveBeenCalledWith({
        where: expect.objectContaining({
          projectId: 'project-123',
          kind: 'FACT',
          subject: 'ticket:1',
          predicate: 'status',
          status: 'active',
          deletedAt: null,
        }),
      });
    });
  });

  describe('reject', () => {
    it('updates status to rejected and clears activeKey', async () => {
      mockMemoryItem.update.mockResolvedValue({});

      await repository.reject('mem-1');

      expect(mockMemoryItem.update).toHaveBeenCalledWith({
        where: { id: 'mem-1' },
        data: { activeKey: null, status: 'rejected' },
      });
    });
  });

  describe('softDelete', () => {
    it('sets deletedAt and clears activeKey', async () => {
      mockMemoryItem.update.mockResolvedValue({});

      await repository.softDelete('mem-1');

      expect(mockMemoryItem.update).toHaveBeenCalledWith({
        where: { id: 'mem-1' },
        data: expect.objectContaining({
          deletedAt: expect.any(Date),
          activeKey: null,
        }),
      });
    });
  });

  describe('updateDirect', () => {
    it('updates only the provided fields', async () => {
      mockMemoryItem.update.mockResolvedValue({});

      await repository.updateDirect('mem-1', { status: 'superseded', activeKey: null });

      expect(mockMemoryItem.update).toHaveBeenCalledWith({
        where: { id: 'mem-1' },
        data: expect.objectContaining({ status: 'superseded', activeKey: null }),
      });
    });

    it('does not set fields not provided in data', async () => {
      mockMemoryItem.update.mockResolvedValue({});

      await repository.updateDirect('mem-1', { status: 'rejected' });

      const callData = mockMemoryItem.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(callData).toHaveProperty('status', 'rejected');
      expect(callData).not.toHaveProperty('confidence');
      expect(callData).not.toHaveProperty('ttlAt');
    });
  });

  describe('upsert', () => {
    it('runs inside a serializable transaction', async () => {
      mockTransaction.mockImplementation((fn: (client: unknown) => Promise<unknown>) => {
        const mockClient = {
          memoryItem: {
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue(makeModelRow()),
            update: jest.fn(),
          },
        };
        return fn(mockClient);
      });

      await repository.upsert({
        projectId: 'project-123',
        kind: MemoryKind.FACT,
        subject: 'ticket:1',
        predicate: 'status',
        object: 'active',
        confidence: 0.9,
      });

      expect(mockTransaction).toHaveBeenCalledWith(
        expect.any(Function),
        { isolationLevel: 'Serializable' },
      );
    });

    it('supersedes existing active item before creating new one', async () => {
      const existingItem = makeModelRow({ id: 'old-mem' });
      const newItem = makeModelRow({ id: 'new-mem' });

      const mockClientMemoryItem = {
        findFirst: jest.fn().mockResolvedValue(existingItem),
        create: jest.fn().mockResolvedValue(newItem),
        update: jest.fn().mockResolvedValue({}),
      };

      mockTransaction.mockImplementation((fn: (client: unknown) => Promise<unknown>) => {
        return fn({ memoryItem: mockClientMemoryItem });
      });

      const result = await repository.upsert({
        projectId: 'project-123',
        kind: MemoryKind.FACT,
        subject: 'ticket:1',
        predicate: 'status',
        object: 'updated',
      });

      expect(mockClientMemoryItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'old-mem' },
          data: expect.objectContaining({ activeKey: null, status: 'superseded' }),
        }),
      );
      expect(mockClientMemoryItem.create).toHaveBeenCalled();
      expect(result.id).toBe('new-mem');
    });

    it('creates item with default confidence 0.8 and status active when not provided', async () => {
      const mockClientMemoryItem = {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(makeModelRow()),
        update: jest.fn(),
      };

      mockTransaction.mockImplementation((fn: (client: unknown) => Promise<unknown>) => {
        return fn({ memoryItem: mockClientMemoryItem });
      });

      await repository.upsert({
        projectId: 'project-123',
        kind: MemoryKind.FACT,
        subject: 'ticket:1',
        predicate: 'status',
      });

      expect(mockClientMemoryItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            confidence: 0.8,
            status: 'active',
          }),
        }),
      );
    });
  });
});

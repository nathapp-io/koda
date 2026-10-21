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
    findMany: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };

  const mockTransaction = vi.fn();

  const mockPrismaClient = {
    memoryItem: mockMemoryItem,
    $transaction: mockTransaction,
  };

  const mockPrismaService = {
    client: mockPrismaClient,
  };

  const mockTransactionManager = {
    run: vi.fn((fn: () => Promise<unknown>) => fn()),
    getClient: vi.fn(),
    isInTransaction: vi.fn(() => false),
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

    vi.clearAllMocks();
  });

  describe('findByProject', () => {
    it('passes skip 0 and take 20 for the first page of 20', async () => {
      mockMemoryItem.findMany.mockResolvedValue([]);
      mockMemoryItem.count.mockResolvedValue(0);

      await repository.findByProject({ projectId: 'project-123' }, { current: 1, size: 20 });

      expect(mockMemoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 }),
      );
    });

    it('filters by kind, subject, predicate when provided', async () => {
      mockMemoryItem.findMany.mockResolvedValue([]);
      mockMemoryItem.count.mockResolvedValue(0);

      await repository.findByProject(
        {
          projectId: 'project-123',
          kind: MemoryKind.FACT,
          subject: 'ticket:1',
          predicate: 'status',
        },
        { current: 1, size: 20 },
      );

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

    it('returns the page envelope with records, total, current and size', async () => {
      const rows = [makeModelRow()];
      mockMemoryItem.findMany.mockResolvedValue(rows);
      mockMemoryItem.count.mockResolvedValue(1);

      const result = await repository.findByProject({ projectId: 'project-123' }, { current: 1, size: 20 });

      expect(result).toEqual(
        expect.objectContaining({
          records: expect.arrayContaining([
            expect.objectContaining({ id: 'mem-1' }),
          ]),
          total: 1,
          current: 1,
          size: 20,
        }),
      );
      expect(result.records).toHaveLength(1);
    });

    it('maps null fields to undefined in domain object', async () => {
      const row = makeModelRow({ object: null, ownerId: null, activeKey: null, deletedAt: null });
      mockMemoryItem.findMany.mockResolvedValue([row]);
      mockMemoryItem.count.mockResolvedValue(1);

      const result = await repository.findByProject({ projectId: 'project-123' }, { current: 1, size: 20 });
      const item = result.records[0];

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
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue(makeModelRow()),
            update: vi.fn(),
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
        findFirst: vi.fn().mockResolvedValue(existingItem),
        create: vi.fn().mockResolvedValue(newItem),
        update: vi.fn().mockResolvedValue({}),
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
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(makeModelRow()),
        update: vi.fn(),
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

  // -------------------------------------------------------------------------
  // Permissions P1 US-008 — ownerType and the supersede hook
  // -------------------------------------------------------------------------

  describe('ownerType (US-008)', () => {
    /** One upsert against a client whose active-row read answers `existing`. */
    const withClient = (existing: unknown, created: unknown = makeModelRow()) => {
      const client = {
        findFirst: vi.fn().mockResolvedValue(existing),
        create: vi.fn().mockResolvedValue(created),
        update: vi.fn().mockResolvedValue({}),
      };
      mockTransaction.mockImplementation((fn: (c: unknown) => Promise<unknown>) => fn({ memoryItem: client }));
      return client;
    };

    it('maps a USER ownerType onto the domain item', async () => {
      mockMemoryItem.findFirst.mockResolvedValue(makeModelRow({ ownerType: 'USER' }));

      const found = await repository.findActive('project-123', 'FACT', 'ticket:1', 'status');

      expect(found?.ownerType).toBe('USER');
    });

    it('answers null for a null ownerType and for a value outside the union', async () => {
      for (const stored of [null, 'ROBOT']) {
        mockMemoryItem.findFirst.mockResolvedValue(makeModelRow({ ownerType: stored }));

        const found = await repository.findActive('project-123', 'FACT', 'ticket:1', 'status');

        expect(found?.ownerType).toBeNull();
      }
    });

    it('stores the ownerType an input carries', async () => {
      const client = withClient(null);

      await repository.upsert({
        projectId: 'project-123',
        kind: MemoryKind.FACT,
        subject: 'ticket:1',
        predicate: 'status',
        ownerId: 'agent-1',
        ownerType: 'AGENT',
      });

      expect(client.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ ownerId: 'agent-1', ownerType: 'AGENT' }) }),
      );
    });

    it('stores null when the input names no ownerType (a system writer)', async () => {
      const client = withClient(null);

      await repository.upsert({
        projectId: 'project-123',
        kind: MemoryKind.FACT,
        subject: 'ticket:1',
        predicate: 'status',
        ownerId: 'user-1',
      });

      expect(client.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ ownerType: null }) }),
      );
    });
  });

  describe('upsert beforeSupersede hook (US-008)', () => {
    const existing = makeModelRow({ id: 'old-mem', ownerId: 'user-2', ownerType: 'USER' });

    const withClient = (existingRow: unknown) => {
      const client = {
        findFirst: vi.fn().mockResolvedValue(existingRow),
        create: vi.fn().mockResolvedValue(makeModelRow({ id: 'new-mem' })),
        update: vi.fn().mockResolvedValue({}),
      };
      mockTransaction.mockImplementation((fn: (c: unknown) => Promise<unknown>) => fn({ memoryItem: client }));
      return client;
    };

    it('runs the hook with the active item, after reading it and before superseding it', async () => {
      const client = withClient(existing);
      const seen: string[] = [];
      let updateCallsWhenCalled = -1;
      const beforeSupersede = vi.fn(async (item: { id: string }) => {
        seen.push(item.id);
        updateCallsWhenCalled = client.update.mock.calls.length;
      });

      await repository.upsert(
        { projectId: 'project-123', kind: MemoryKind.FACT, subject: 'ticket:1', predicate: 'status', object: 'new' },
        { beforeSupersede },
      );

      expect(seen).toEqual(['old-mem']);
      expect(updateCallsWhenCalled).toBe(0);
      expect(client.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'old-mem' } }),
      );
    });

    it('writes nothing when the hook throws', async () => {
      const client = withClient(existing);
      const refusal = new Error('refused');

      await expect(
        repository.upsert(
          { projectId: 'project-123', kind: MemoryKind.FACT, subject: 'ticket:1', predicate: 'status', object: 'new' },
          { beforeSupersede: async () => { throw refusal; } },
        ),
      ).rejects.toBe(refusal);

      expect(client.update).not.toHaveBeenCalled();
      expect(client.create).not.toHaveBeenCalled();
    });

    it('does not run the hook on the identical-restatement no-op path', async () => {
      const sameRow = makeModelRow({
        object: 'active', sourceType: 'ticket_event', sourceId: 'evt-1',
      });
      const client = withClient(sameRow);
      const beforeSupersede = vi.fn();

      const result = await repository.upsert(
        {
          projectId: 'project-123', kind: MemoryKind.FACT, subject: 'ticket:1', predicate: 'status',
          object: 'active', sourceType: 'ticket_event', sourceId: 'evt-1',
        },
        { beforeSupersede },
      );

      expect(beforeSupersede).not.toHaveBeenCalled();
      expect(client.create).not.toHaveBeenCalled();
      expect(result.id).toBe('mem-1');
    });
  });

  describe('ticketInProject (US-008)', () => {
    const mockTicket = { count: vi.fn() };

    beforeEach(() => {
      (mockPrismaClient as unknown as Record<string, unknown>)['ticket'] = mockTicket;
    });

    it('counts a non-deleted ticket of that project and id', async () => {
      mockTicket.count.mockResolvedValue(1);

      await expect(repository.ticketInProject('project-123', 'ticket-9')).resolves.toBe(true);
      expect(mockTicket.count).toHaveBeenCalledWith({
        where: { id: 'ticket-9', projectId: 'project-123', deletedAt: null },
      });
    });

    it('answers false when no live ticket of that project has the id', async () => {
      mockTicket.count.mockResolvedValue(0);

      await expect(repository.ticketInProject('project-123', 'ticket-other-project')).resolves.toBe(false);
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService, PrismaAppException, PRISMA_ERROR_CODES } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import {
  PrismaMemoryItemRepository,
  buildActiveKey,
  MEMORY_UPSERT_MAX_ATTEMPTS,
  memoryUpsertBackoffMs,
} from './prisma-memory-item.repository';
import { Prisma } from '../generated/prisma/client';
import { MemoryKind } from '../common/enums';

const makeModelRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'mem-1',
  projectId: 'project-123',
  kind: 'FACT',
  subject: 'ticket:1',
  predicate: 'status',
  object: 'active',
  // US-001: a triple row stores no index line, exactly as `db push` leaves the column for every old row.
  description: null,
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
  const mockWithTransaction = vi.fn();

  const mockPrismaClient = {
    memoryItem: mockMemoryItem,
    $transaction: mockTransaction,
    // memory-notes US-003: the lexeme probe in front of the ranked full-text path answers "no lexeme" by
    // default, so a text here keeps taking the pre-feature `contains` path.
    $queryRaw: vi.fn().mockResolvedValue([{ lexemes: 0 }]),
  };

  const mockPrismaService = {
    client: mockPrismaClient,
    withTransaction: mockWithTransaction,
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
    // Review 1114 US-007: `upsert` writes through the transaction manager, not `PrismaService.withTransaction`
    // — `run` enters the callback once and `getClient` answers the transaction's client, exactly as the real
    // manager does inside `run`. A case controls the write through `mockMemoryItem` and the attempt through
    // `mockTransactionManager.run`.
    mockTransactionManager.run.mockImplementation((fn: () => Promise<unknown>) => fn());
    mockTransactionManager.isInTransaction.mockReturnValue(false);
    mockTransactionManager.getClient.mockReturnValue(mockPrismaClient);
  });

  /**
   * Enters the transaction `upsert` opens, with `mockMemoryItem` answering the active-row read, the supersede
   * and the insert. Returns the client the attempt writes through.
   */
  const enterTransaction = (existingRow: unknown, created: unknown = makeModelRow({ id: 'new-mem' })) => {
    mockMemoryItem.findFirst.mockResolvedValue(existingRow);
    mockMemoryItem.create.mockResolvedValue(created);
    mockMemoryItem.update.mockResolvedValue({});
    return mockMemoryItem;
  };

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
      // US-001: the lookup is the active key, so a note (whose key is its slug alone) is found the same way.
      expect(mockMemoryItem.findFirst).toHaveBeenCalledWith({
        where: {
          projectId: 'project-123',
          activeKey: 'FACT:ticket:1:status',
          status: 'active',
          deletedAt: null,
        },
      });
    });

    it('looks a NOTE up by its slug key alone', async () => {
      mockMemoryItem.findFirst.mockResolvedValue(makeModelRow({ kind: 'NOTE', activeKey: 'NOTE:replay-budget' }));

      await repository.findActive('project-123', 'NOTE', 'replay-budget', 'project');

      expect(mockMemoryItem.findFirst).toHaveBeenCalledWith({
        where: {
          projectId: 'project-123',
          activeKey: 'NOTE:replay-budget',
          status: 'active',
          deletedAt: null,
        },
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
    it('runs on the transaction manager with Serializable isolation', async () => {
      enterTransaction(null);

      await repository.upsert({
        projectId: 'project-123',
        kind: MemoryKind.FACT,
        subject: 'ticket:1',
        predicate: 'status',
        object: 'active',
        confidence: 0.9,
      });

      expect(mockTransactionManager.run).toHaveBeenCalledWith(
        expect.any(Function),
        { isolationLevel: 'Serializable' },
      );
      // The write never opens a transaction behind the manager's back.
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('supersedes existing active item before creating new one', async () => {
      const existingItem = makeModelRow({ id: 'old-mem' });
      const client = enterTransaction(existingItem, makeModelRow({ id: 'new-mem' }));

      const result = await repository.upsert({
        projectId: 'project-123',
        kind: MemoryKind.FACT,
        subject: 'ticket:1',
        predicate: 'status',
        object: 'updated',
      });

      expect(client.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'old-mem' },
          data: expect.objectContaining({ activeKey: null, status: 'superseded' }),
        }),
      );
      expect(client.create).toHaveBeenCalled();
      expect(result.id).toBe('new-mem');
    });

    it('creates item with default confidence 0.8 and status active when not provided', async () => {
      const client = enterTransaction(null, makeModelRow());

      await repository.upsert({
        projectId: 'project-123',
        kind: MemoryKind.FACT,
        subject: 'ticket:1',
        predicate: 'status',
      });

      expect(client.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            confidence: 0.8,
            status: 'active',
          }),
        }),
      );
    });

    it('AC-14: a note restated with no sourceId matches the stored null and writes no row', async () => {
      // The REST route leaves `sourceId` out entirely, so the stored row carries `null` while the replay
      // carries `undefined`: the two name the same source, so this is the no-op, not a supersede.
      const existingRow = makeModelRow({
        id: 'note-1',
        kind: 'NOTE',
        subject: 'replay-budget',
        predicate: 'project',
        object: 'Budget stays 2,048 MiB.',
        description: 'replay budget',
        activeKey: 'NOTE:replay-budget',
        sourceType: 'manual',
        sourceId: null,
      });
      const client = enterTransaction(existingRow);

      const result = await repository.upsert({
        projectId: 'project-123',
        kind: MemoryKind.NOTE,
        subject: 'replay-budget',
        predicate: 'project',
        object: 'Budget stays 2,048 MiB.',
        description: 'replay budget',
        sourceType: 'manual',
      });

      expect(result.id).toBe('note-1');
      expect(client.create).not.toHaveBeenCalled();
      expect(client.update).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Permissions P1 US-008 — ownerType and the supersede hook
  // -------------------------------------------------------------------------

  describe('ownerType (US-008)', () => {
    /** One upsert against a client whose active-row read answers `existing`. */
    const withClient = (existing: unknown, created: unknown = makeModelRow()) => enterTransaction(existing, created);

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

    const withClient = (existingRow: unknown) => enterTransaction(existingRow);

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

  // -------------------------------------------------------------------------
  // Permissions P2 US-002 — the upsert runs on the transaction manager and calls onWritten
  // -------------------------------------------------------------------------

  describe('upsert transaction and onWritten hook (US-002)', () => {
    /** The transaction manager's client for one upsert: the active-row read answers `existingRow`. */
    const withTransactionClient = (existingRow: unknown) => enterTransaction(existingRow);

    /** The identical-restatement row the no-op path answers with. */
    const restatement = makeModelRow({ object: 'active', sourceType: 'ticket_event', sourceId: 'evt-1' });
    const restatementInput = {
      projectId: 'project-123', kind: MemoryKind.FACT, subject: 'ticket:1', predicate: 'status',
      object: 'active', sourceType: 'ticket_event', sourceId: 'evt-1',
    };

    it('AC-24: runs on the transaction manager with Serializable isolation', async () => {
      withTransactionClient(restatement);

      await repository.upsert(restatementInput);

      expect(mockTransactionManager.run).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
      // The raw client transaction is never entered behind the transaction manager's back.
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('AC-25: a restatement calls neither onWritten nor beforeSupersede', async () => {
      withTransactionClient(restatement);
      const onWritten = vi.fn();
      const beforeSupersede = vi.fn();

      const result = await repository.upsert(restatementInput, { onWritten, beforeSupersede });

      expect(mockTransactionManager.run).toHaveBeenCalledTimes(1);
      expect(onWritten).not.toHaveBeenCalled();
      expect(beforeSupersede).not.toHaveBeenCalled();
      expect(result.id).toBe('mem-1');
    });

    it('calls onWritten with the created item and the item it superseded, after the create', async () => {
      const client = withTransactionClient(makeModelRow({ id: 'old-mem' }));
      const onWritten = vi.fn(async () => undefined);
      let createCallsWhenCalled = -1;
      onWritten.mockImplementation(async () => { createCallsWhenCalled = client.create.mock.calls.length; });

      await repository.upsert(
        { projectId: 'project-123', kind: MemoryKind.FACT, subject: 'ticket:1', predicate: 'status', object: 'v2' },
        { onWritten },
      );

      expect(onWritten).toHaveBeenCalledWith({
        item: expect.objectContaining({ id: 'new-mem' }),
        superseded: expect.objectContaining({ id: 'old-mem' }),
      });
      expect(createCallsWhenCalled).toBe(1);
    });

    it('calls onWritten with no superseded item on a fresh key', async () => {
      withTransactionClient(null);
      const onWritten = vi.fn(async () => undefined);

      await repository.upsert(
        { projectId: 'project-123', kind: MemoryKind.FACT, subject: 'ticket:1', predicate: 'status', object: 'v1' },
        { onWritten },
      );

      expect(onWritten).toHaveBeenCalledWith({ item: expect.objectContaining({ id: 'new-mem' }), superseded: null });
    });

    it('lets the hook\'s refusal reach the caller, so the transaction rolls back the writes', async () => {
      const client = withTransactionClient(makeModelRow({ id: 'old-mem' }));
      const refusal = new Error('audit down');

      await expect(
        repository.upsert(
          { projectId: 'project-123', kind: MemoryKind.FACT, subject: 'ticket:1', predicate: 'status', object: 'v2' },
          { onWritten: async () => { throw refusal; } },
        ),
      ).rejects.toBe(refusal);

      // The update and the create ran before the hook threw; the transaction manager is what rolls them back.
      expect(mockTransactionManager.run).toHaveBeenCalledTimes(1);
      expect(client.create).toHaveBeenCalledTimes(1);
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

  // -------------------------------------------------------------------------
  // Review 1114 US-007 — a note upsert that lost a same-slug race retries a new transaction
  // -------------------------------------------------------------------------

  describe('upsert conflict retry (US-007)', () => {
    /** The P2002 Postgres raises for the loser of a same-slug race: the active-key index. */
    const uniqueOnActiveKey = (): Prisma.PrismaClientKnownRequestError =>
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['projectId', 'activeKey'] },
      });

    /** The P2034 the serializable isolation level raises when two writers conflict. */
    const serializationFailure = (): Prisma.PrismaClientKnownRequestError =>
      new Prisma.PrismaClientKnownRequestError('write conflict or deadlock', {
        code: 'P2034',
        clientVersion: 'test',
      });

    /** A P2003 that is neither eligible conflict, so it must propagate on its first attempt. */
    const foreignKeyViolation = (): Prisma.PrismaClientKnownRequestError =>
      new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', {
        code: 'P2003',
        clientVersion: 'test',
        meta: { field_name: 'MemoryItem_projectId_fkey' },
      });

    /** The note every retry case upserts. */
    const noteInput = () => ({
      projectId: 'project-123',
      kind: MemoryKind.NOTE,
      subject: 'replay-budget',
      predicate: 'project',
      object: 'Budget stays 2,048 MiB.',
      description: 'replay budget',
    });

    /** The delay the retry takes, recorded instead of slept. */
    let delays: number[];
    let retryDelay: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      delays = [];
      mockTransactionManager.run.mockReset();
      mockTransactionManager.run.mockImplementation((fn: () => Promise<unknown>) => fn());
      mockTransactionManager.isInTransaction.mockReturnValue(false);
      // Inside `run` the manager's client is the transaction client; the same view serves every attempt.
      mockTransactionManager.getClient.mockReturnValue(mockPrismaClient);
      mockMemoryItem.findFirst.mockResolvedValue(null);
      mockMemoryItem.create.mockResolvedValue(makeModelRow({ id: 'created-1' }));
      mockMemoryItem.update.mockResolvedValue({});
      retryDelay = vi
        .spyOn(repository as unknown as { retryDelay: (attempt: number) => Promise<void> }, 'retryDelay')
        .mockImplementation(async (attempt: number) => {
          delays.push(attempt);
        });
    });

    afterEach(() => {
      retryDelay.mockRestore();
    });

    it('AC-1: exports MEMORY_UPSERT_MAX_ATTEMPTS as 3', () => {
      expect(MEMORY_UPSERT_MAX_ATTEMPTS).toBe(3);
    });

    it('AC-4: an activeKey unique violation retries and answers the second attempt', async () => {
      mockMemoryItem.create.mockResolvedValue(makeModelRow({ id: 'second-attempt' }));
      mockTransactionManager.run.mockRejectedValueOnce(uniqueOnActiveKey());

      const result = await repository.upsert(noteInput());

      expect(result.id).toBe('second-attempt');
      expect(mockTransactionManager.run).toHaveBeenCalledTimes(2);
    });

    it('AC-5: a serialization failure retries in a new Serializable transaction', async () => {
      mockMemoryItem.create.mockResolvedValue(makeModelRow({ id: 'second-attempt' }));
      mockTransactionManager.run.mockRejectedValueOnce(serializationFailure());

      const result = await repository.upsert(noteInput());

      expect(result.id).toBe('second-attempt');
      expect(mockTransactionManager.run).toHaveBeenCalledTimes(2);
      expect(mockTransactionManager.run).toHaveBeenNthCalledWith(1, expect.any(Function), {
        isolationLevel: 'Serializable',
      });
      expect(mockTransactionManager.run).toHaveBeenNthCalledWith(2, expect.any(Function), {
        isolationLevel: 'Serializable',
      });
    });

    it('AC-6: three lost races reject as DUPLICATE_ENTRY after exactly three attempts', async () => {
      mockTransactionManager.run.mockRejectedValue(uniqueOnActiveKey());

      const error = await repository.upsert(noteInput()).catch((e: unknown) => e);

      expect(mockTransactionManager.run).toHaveBeenCalledTimes(3);
      expect(error).toBeInstanceOf(PrismaAppException);
      expect((error as PrismaAppException).code).toBe(PRISMA_ERROR_CODES.DUPLICATE_ENTRY);
    });

    it('AC-7: a foreign-key violation is not a conflict, so it propagates mapped after one attempt', async () => {
      mockTransactionManager.run.mockRejectedValue(foreignKeyViolation());

      const error = await repository.upsert(noteInput()).catch((e: unknown) => e);

      expect(mockTransactionManager.run).toHaveBeenCalledTimes(1);
      expect(error).toBeInstanceOf(PrismaAppException);
      expect((error as PrismaAppException).code).toBe(PRISMA_ERROR_CODES.INVALID_REFERENCE);
    });

    it('AC-8: inside an outer transaction it makes one attempt and never retries the aborted transaction', async () => {
      mockTransactionManager.isInTransaction.mockReturnValue(true);
      mockTransactionManager.run.mockRejectedValue(uniqueOnActiveKey());

      const error = await repository.upsert(noteInput()).catch((e: unknown) => e);

      expect(mockTransactionManager.run).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([]);
      expect((error as PrismaAppException).code).toBe(PRISMA_ERROR_CODES.DUPLICATE_ENTRY);
    });

    it('AC-9: waits before the second attempt, once, naming the first attempt', async () => {
      let runsWhenDelayed = -1;
      retryDelay.mockImplementation(async (attempt: number) => {
        delays.push(attempt);
        runsWhenDelayed = mockTransactionManager.run.mock.calls.length;
      });
      mockTransactionManager.run.mockRejectedValueOnce(serializationFailure());

      await repository.upsert(noteInput());

      expect(delays).toEqual([1]);
      expect(runsWhenDelayed).toBe(1);
      expect(mockTransactionManager.run).toHaveBeenCalledTimes(2);
    });

    it('AC-10: the backoff is attempt × round(10 + 40 × random)', () => {
      expect(memoryUpsertBackoffMs(2, () => 0.5)).toBe(60);
      expect(memoryUpsertBackoffMs(1, () => 0)).toBe(10);
      expect(memoryUpsertBackoffMs(3, () => 1)).toBe(150);
    });

    it('AC-13: a non-Prisma error propagates as itself on the first attempt', async () => {
      const refusal = new Error('beforeWrite refused');
      mockMemoryItem.findFirst.mockRejectedValue(refusal);

      await expect(repository.upsert(noteInput())).rejects.toBe(refusal);
      expect(mockTransactionManager.run).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([]);
    });

    it('AC-13: a P2002 on another index is mapped but not retried', async () => {
      mockTransactionManager.run.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['ownerKey', 'otherKey'] },
        }),
      );

      const error = await repository.upsert(noteInput()).catch((e: unknown) => e);

      expect(mockTransactionManager.run).toHaveBeenCalledTimes(1);
      expect(error).toBeInstanceOf(PrismaAppException);
      expect((error as PrismaAppException).code).toBe(PRISMA_ERROR_CODES.DUPLICATE_ENTRY);
    });

    it('AC-14: the last of three conflicts is the error that leaves, and no fourth transaction starts', async () => {
      mockTransactionManager.run
        .mockRejectedValueOnce(serializationFailure())
        .mockRejectedValueOnce(uniqueOnActiveKey())
        .mockRejectedValueOnce(serializationFailure());

      const error = await repository.upsert(noteInput()).catch((e: unknown) => e);

      expect(mockTransactionManager.run).toHaveBeenCalledTimes(3);
      // The last failure is a P2034, so the mapping — not the earlier P2002 — is what the caller sees.
      expect(error).toBeInstanceOf(PrismaAppException);
      expect((error as PrismaAppException).code).toBe(PRISMA_ERROR_CODES.DATABASE_ERROR);
      // No delay after the last attempt.
      expect(delays).toEqual([1, 2]);
    });

    it('AC-14: the final eligible conflict is mapped, never the first', async () => {
      mockTransactionManager.run
        .mockRejectedValueOnce(serializationFailure())
        .mockRejectedValueOnce(serializationFailure())
        .mockRejectedValueOnce(uniqueOnActiveKey());

      const error = await repository.upsert(noteInput()).catch((e: unknown) => e);

      expect(mockTransactionManager.run).toHaveBeenCalledTimes(3);
      expect((error as PrismaAppException).code).toBe(PRISMA_ERROR_CODES.DUPLICATE_ENTRY);
    });
  });
});

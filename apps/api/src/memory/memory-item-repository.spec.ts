import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaMemoryItemRepository } from './prisma-memory-item.repository';

describe('PrismaMemoryItemRepository.findByProjectMemory', () => {
  let repository: PrismaMemoryItemRepository;
  let prismaService: PrismaService<any>;

  const mockPrismaClient = {
    memoryItem: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    $queryRaw: vi.fn(),
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
    prismaService = module.get<PrismaService<any>>(PrismaService);

    vi.clearAllMocks();
    // memory-notes US-003: the lexeme probe gates the ranked path. "No lexeme" is the default here, so the
    // pre-feature `contains` path is the one these tests describe.
    mockPrismaClient.$queryRaw.mockResolvedValue([{ lexemes: 0 }]);
  });

  describe('default active filter', () => {
    it('defaults to status=active and includes non-expired TTL items when no status provided', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory({ projectId: 'project-123' }, { current: 1, size: 10 });

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

      await repository.findByProjectMemory({ projectId: 'project-123', kind: 'FACT' }, { current: 1, size: 10 });

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

      await repository.findByProjectMemory({ projectId: 'project-123', subject: 'ticket:123' }, { current: 1, size: 10 });

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

      await repository.findByProjectMemory({ projectId: 'project-123', status: 'superseded' }, { current: 1, size: 10 });

      const callArgs = mockPrismaClient.memoryItem.findMany.mock.calls[0][0] as Record<string, unknown>;
      const where = callArgs.where as Record<string, unknown>;
      expect(where.status).toBe('superseded');
      expect(where.OR).toBeUndefined();
    });
  });

  describe('case-insensitive text filter', () => {
    const textTerm = (text: string) => ({
      OR: [
        { subject: { contains: text, mode: 'insensitive' } },
        { predicate: { contains: text, mode: 'insensitive' } },
        { object: { contains: text, mode: 'insensitive' } },
      ],
    });

    it('adds its own AND term over subject, predicate and object without replacing the TTL OR', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory({ projectId: 'project-123', text: 'deploy' }, { current: 1, size: 10 });

      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            projectId: 'project-123',
            deletedAt: null,
            status: 'active',
            OR: [{ ttlAt: null }, { ttlAt: { gt: expect.any(Date) } }],
            AND: [textTerm('deploy')],
          }),
        }),
      );
    });

    it('combines with an explicit status, which has no TTL OR of its own', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory(
        { projectId: 'project-123', status: 'superseded', text: 'deploy' },
        { current: 1, size: 10 },
      );

      const callArgs = mockPrismaClient.memoryItem.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
      expect(callArgs.where.AND).toEqual([textTerm('deploy')]);
      expect(callArgs.where.OR).toBeUndefined();
    });

    it('adds no AND term when text is absent or blank', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory({ projectId: 'project-123' }, { current: 1, size: 10 });
      await repository.findByProjectMemory({ projectId: 'project-123', text: '   ' }, { current: 1, size: 10 });

      for (const call of mockPrismaClient.memoryItem.findMany.mock.calls) {
        const where = (call[0] as { where: Record<string, unknown> }).where;
        expect(where.AND).toBeUndefined();
      }
    });
  });

  describe('ordering variants', () => {
    it('should order by confidence desc, updatedAt desc, createdAt desc by default', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory({ projectId: 'project-123' }, { current: 1, size: 10 });

      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [
            { confidence: 'desc' },
            { updatedAt: 'desc' },
            { createdAt: 'desc' },
            { id: 'desc' },
          ],
        }),
      );
    });

    it('should support updatedAt ordering', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory({ projectId: 'project-123', orderBy: 'updatedAt' }, { current: 1, size: 10 });

      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [
            { updatedAt: 'desc' },
            { confidence: 'desc' },
            { createdAt: 'desc' },
            { id: 'desc' },
          ],
        }),
      );
    });

    it('should support createdAt ordering', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory({ projectId: 'project-123', orderBy: 'createdAt' }, { current: 1, size: 10 });

      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [
            { createdAt: 'desc' },
            { confidence: 'desc' },
            { updatedAt: 'desc' },
            { id: 'desc' },
          ],
        }),
      );
    });
  });

  describe('pagination', () => {
    it('should skip 20 and take 10 for page 3 with size 10', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory({ projectId: 'project-123' }, { current: 3, size: 10 });

      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 20,
          take: 10,
        }),
      );
    });
  });

  describe('return shape', () => {
    it('should return the page envelope with records, total, current and size', async () => {
      const mockItems = [
        { id: 'mem-1', projectId: 'project-123', kind: 'FACT', subject: 'ticket:1', predicate: 'status', confidence: 0.9, status: 'active', createdAt: new Date(), updatedAt: new Date() },
      ];
      mockPrismaClient.memoryItem.findMany.mockResolvedValue(mockItems);
      mockPrismaClient.memoryItem.count.mockResolvedValue(1);

      const result = await repository.findByProjectMemory({ projectId: 'project-123' }, { current: 1, size: 10 });

      expect(result).toEqual(
        expect.objectContaining({
          // US-008: the mapper reads `ownerType` too; a model row without one is a system item (null).
          records: [expect.objectContaining({ ...mockItems[0], ownerType: null })],
          total: 1,
          current: 1,
          size: 10,
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // memory-notes US-003 — the ranked full-text path and its fallback
  // -------------------------------------------------------------------------

  describe('ranked full-text path (US-003)', () => {
    const row = (id: string) => ({
      id, projectId: 'project-123', kind: 'FACT', subject: 'ticket:1', predicate: 'status',
      confidence: 0.9, status: 'active', createdAt: new Date(), updatedAt: new Date(),
    });

    /** `$queryRaw` in call order: the probe, the page of ids, the count — each as the SQL it was given. */
    const rawCalls = (): Array<{ sql: string; values: unknown[] }> =>
      mockPrismaClient.$queryRaw.mock.calls.map((call) => call[0] as { sql: string; values: unknown[] });

    /** The probe found a lexeme, the page answers `ids` and the count answers `total`. */
    const ranked = (ids: string[], total: number): void => {
      mockPrismaClient.$queryRaw
        .mockResolvedValueOnce([{ lexemes: 1 }])
        .mockResolvedValueOnce(ids.map((id) => ({ id })))
        .mockResolvedValueOnce([{ total }]);
    };

    it('asks Postgres for the lexemes of the text before it ranks anything', async () => {
      ranked([], 0);
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory({ projectId: 'project-123', text: 'deploy' }, { current: 1, size: 10 });

      expect(rawCalls()[0].sql).toContain('numnode(websearch_to_tsquery(');
      expect(rawCalls()[0].values).toContain('deploy');
      expect(rawCalls()[0].values).toContain('english');
    });

    it('ranks, filters and pages in SQL, then loads the rows by id and keeps rank order', async () => {
      ranked(['mem-2', 'mem-1'], 2);
      // `in` answers in its own order on purpose: the ranked order must be restored from the id list.
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([row('mem-1'), row('mem-2')]);

      const result = await repository.findByProjectMemory(
        { projectId: 'project-123', text: 'deploy', kind: 'FACT', subject: 'a_b' },
        { current: 2, size: 5 },
      );

      const idsQuery = rawCalls()[1];
      expect(idsQuery.sql).toContain('FROM "MemoryItem" m');
      expect(idsQuery.sql).toContain('ORDER BY ts_rank(m."searchVector", websearch_to_tsquery(');
      expect(idsQuery.sql).toContain(`starts_with(m."subject", ?)`);
      expect(idsQuery.sql).toContain(`m."deletedAt" IS NULL`);
      expect(idsQuery.sql).toContain(`m."status" = 'active'`);
      // The text term is an AND with the TTL bound, never an OR next to it (S5b US-004 invariant).
      expect(idsQuery.sql).toContain('OR m."ttlAt" > ');
      expect(idsQuery.sql).toMatch(/OFFSET \? LIMIT \?$/);
      expect(idsQuery.values).toEqual(expect.arrayContaining(['project-123', 'FACT', 'a_b', 'deploy']));
      // resolvePageOption: page 2 of 5 skips 5 and takes 5.
      expect(idsQuery.values.slice(-2)).toEqual([5, 5]);

      expect(rawCalls()[2].sql).toContain('count(*)::int');
      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['mem-2', 'mem-1'] }, deletedAt: null },
      });
      expect(result.records.map((item) => item.id)).toEqual(['mem-2', 'mem-1']);
      expect(result).toEqual(expect.objectContaining({ total: 2, current: 2, size: 5 }));
    });

    it('applies the requested orderBy instead of rank when the caller names one', async () => {
      ranked(['mem-1'], 1);
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([row('mem-1')]);

      await repository.findByProjectMemory(
        { projectId: 'project-123', text: 'deploy', orderBy: 'updatedAt' },
        { current: 1, size: 10 },
      );

      const idsQuery = rawCalls()[1];
      expect(idsQuery.sql).not.toContain('ts_rank');
      expect(idsQuery.sql).toContain('ORDER BY m."updatedAt" DESC, m."confidence" DESC, m."createdAt" DESC, m."id" DESC');
    });

    it('applies an explicit status without the TTL bound', async () => {
      ranked(['mem-1'], 1);
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([row('mem-1')]);

      await repository.findByProjectMemory(
        { projectId: 'project-123', text: 'deploy', status: 'superseded' },
        { current: 1, size: 10 },
      );

      const idsQuery = rawCalls()[1];
      expect(idsQuery.sql).toContain(`m."status" = ?`);
      expect(idsQuery.sql).not.toContain('ttlAt');
      expect(idsQuery.values).toContain('superseded');
    });

    it('falls back to the contains path when the ranked query matched nothing', async () => {
      ranked([], 0);
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory({ projectId: 'project-123', text: '预算' }, { current: 1, size: 10 });

      expect(rawCalls()).toHaveLength(3);
      expect(mockPrismaClient.memoryItem.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          AND: [
            {
              OR: [
                { subject: { contains: '预算', mode: 'insensitive' } },
                { predicate: { contains: '预算', mode: 'insensitive' } },
                { object: { contains: '预算', mode: 'insensitive' } },
              ],
            },
          ],
        }),
      });
    });

    it('never probes or ranks for a blank text', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory({ projectId: 'project-123', text: '   ' }, { current: 1, size: 10 });

      expect(mockPrismaClient.$queryRaw).not.toHaveBeenCalled();
    });
  });
});

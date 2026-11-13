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

  /** The substring term the fallback adds: a case-insensitive `contains` over every searchable field (#456). */
  const textTerm = (text: string) => ({
    OR: [
      { subject: { contains: text, mode: 'insensitive' } },
      { predicate: { contains: text, mode: 'insensitive' } },
      { object: { contains: text, mode: 'insensitive' } },
      { description: { contains: text, mode: 'insensitive' } },
    ],
  });

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
    it('adds its own AND term over subject, predicate, object and description without replacing the TTL OR', async () => {
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
    const ranked = (ids: string[], total: number, query?: string | null): void => {
      mockPrismaClient.$queryRaw
        .mockResolvedValueOnce([{ lexemes: 1, ...(query !== undefined ? { query } : {}) }])
        .mockResolvedValueOnce(ids.map((id) => ({ id })))
        .mockResolvedValueOnce([{ total }]);
    };

    it('asks Postgres for the lexemes of the text before it ranks anything', async () => {
      ranked([], 0);
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory({ projectId: 'project-123', text: 'deploy' }, { current: 1, size: 10 });

      expect(rawCalls()[0].sql).toContain('numnode(websearch_to_tsquery(');
      expect(rawCalls()[0].sql).toContain('::text AS "query"');
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
                { description: { contains: '预算', mode: 'insensitive' } },
              ],
            },
          ],
        }),
      });
    });

    it('runs the any-word ranked query only after an eligible multi-word probe', async () => {
      mockPrismaClient.$queryRaw
        .mockResolvedValueOnce([{ lexemes: 2, query: "'deploy' & 'backup'" }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory({ projectId: 'project-123', text: 'deploy backup' }, { current: 1, size: 10 });

      expect(rawCalls()).toHaveLength(5);
      expect(rawCalls()[3].sql).toContain('replace(');
      expect(rawCalls()[3].sql).toContain("' | ')::tsquery");
      // Both ranked passes came back empty, so the substring path answers — over all four fields, the whole
      // text as one term (AC-6). A fallback that dropped `description` would leave every other case green.
      expect(mockPrismaClient.memoryItem.count).toHaveBeenCalledWith({
        where: expect.objectContaining({ AND: [textTerm('deploy backup')] }),
      });
    });

    it('hydrates any-word matches in rank order without counting through Prisma', async () => {
      mockPrismaClient.$queryRaw
        .mockResolvedValueOnce([{ lexemes: 2, query: "'deploy' & 'backup'" }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }])
        .mockResolvedValueOnce([{ id: 'mem-2' }, { id: 'mem-1' }])
        .mockResolvedValueOnce([{ total: 2 }]);
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([row('mem-1'), row('mem-2')]);

      const result = await repository.findByProjectMemory(
        { projectId: 'project-123', text: 'deploy backup' }, { current: 1, size: 10 },
      );

      expect(result.records.map((item) => item.id)).toEqual(['mem-2', 'mem-1']);
      expect(result.total).toBe(2);
      expect(mockPrismaClient.memoryItem.count).not.toHaveBeenCalled();
    });

    it.each([undefined, "'deploy' & !'backup'", "'deploy'"])(
      'does not issue an any-word pass for probe query %s', async (query) => {
        ranked([], 0, query);
        mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
        mockPrismaClient.memoryItem.count.mockResolvedValue(0);

        await repository.findByProjectMemory({ projectId: 'project-123', text: 'deploy' }, { current: 1, size: 10 });

        expect(rawCalls()).toHaveLength(3);
      },
    );

    it('returns all-word matches without trying any-word search', async () => {
      ranked(['mem-1'], 1, "'deploy' & 'backup'");
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([row('mem-1')]);

      await repository.findByProjectMemory({ projectId: 'project-123', text: 'deploy backup' }, { current: 1, size: 10 });

      expect(rawCalls()).toHaveLength(3);
    });

    it('never probes or ranks for a blank text', async () => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);

      await repository.findByProjectMemory({ projectId: 'project-123', text: '   ' }, { current: 1, size: 10 });

      expect(mockPrismaClient.$queryRaw).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // memory-notes US-005 — whose rows a project read answers
  // -------------------------------------------------------------------------

  describe('owner union and scope (US-005)', () => {
    const owner = { ownerType: 'AGENT', ownerId: 'agent-a' } as const;
    const OWNER_KEY = 'AGENT:agent-a';

    /** The `where` the `contains` path handed Prisma on its last call. */
    const whereOfLastFind = (): Record<string, unknown> => {
      const calls = mockPrismaClient.memoryItem.findMany.mock.calls;
      const last = calls[calls.length - 1] as [{ where: Record<string, unknown> }];
      return last[0].where;
    };

    /** The ids query the ranked path issued (the probe is call 0, the page of ids call 1). */
    const rankedIdsQuery = (): { sql: string; values: unknown[] } =>
      mockPrismaClient.$queryRaw.mock.calls[1][0] as { sql: string; values: unknown[] };

    /** The probe found a lexeme and the ranked page answered one row. */
    const rankedOne = (): void => {
      mockPrismaClient.$queryRaw
        .mockResolvedValueOnce([{ lexemes: 1 }])
        .mockResolvedValueOnce([{ id: 'mem-1' }])
        .mockResolvedValueOnce([{ total: 1 }]);
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([
        { id: 'mem-1', projectId: 'project-123', kind: 'FACT', subject: 'ticket:1', predicate: 'status', confidence: 0.9, status: 'active', createdAt: new Date(), updatedAt: new Date() },
      ]);
    };

    beforeEach(() => {
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.count.mockResolvedValue(0);
    });

    it('AC-7: with no owner the read stays project-only, even when scope user is asked', async () => {
      await repository.findByProjectMemory({ projectId: 'project-123', scope: 'user' }, { current: 1, size: 10 });

      const where = whereOfLastFind();
      expect(where.projectId).toBe('project-123');
      // Nothing of the scope survives: no owner means no user row can be named at all.
      expect(JSON.stringify(where)).not.toContain('ownerKey');
      expect(where.AND).toBeUndefined();
    });

    it('scope user answers the owner-keyed rows only', async () => {
      await repository.findByProjectMemory({ projectId: 'project-123', scope: 'user', owner }, { current: 1, size: 10 });

      const where = whereOfLastFind();
      expect(where.ownerKey).toBe(OWNER_KEY);
      expect(where.projectId).toBeUndefined();
    });

    it('scope project keeps the owner out of the page', async () => {
      await repository.findByProjectMemory({ projectId: 'project-123', scope: 'project', owner }, { current: 1, size: 10 });

      const where = whereOfLastFind();
      expect(where.projectId).toBe('project-123');
      expect(JSON.stringify(where)).not.toContain('ownerKey');
    });

    it('AC-1: an owner with no scope is answered the authorized union of project and owner rows', async () => {
      await repository.findByProjectMemory({ projectId: 'project-123', owner }, { current: 1, size: 10 });

      const where = whereOfLastFind();
      expect(where.projectId).toBeUndefined();
      // The union is its own AND term, so the TTL `OR` and the text term keep their meaning beside it.
      expect(where.AND).toContainEqual({ OR: [{ projectId: 'project-123' }, { ownerKey: OWNER_KEY }] });
    });

    it('scope all is the same union as the default', async () => {
      await repository.findByProjectMemory({ projectId: 'project-123', scope: 'all', owner }, { current: 1, size: 10 });

      expect(whereOfLastFind().AND).toContainEqual({ OR: [{ projectId: 'project-123' }, { ownerKey: OWNER_KEY }] });
    });

    it('AC-1: the union keeps the text term as a separate AND, never beside the TTL OR', async () => {
      await repository.findByProjectMemory({ projectId: 'project-123', scope: 'all', owner, text: 'working' }, { current: 1, size: 10 });

      const and = whereOfLastFind().AND as unknown[];
      expect(and).toHaveLength(2);
      expect(and).toContainEqual({ OR: [{ projectId: 'project-123' }, { ownerKey: OWNER_KEY }] });
    });

    it('AC-5: the ranked path filters the union by ownerKey as a bound value', async () => {
      rankedOne();

      await repository.findByProjectMemory({ projectId: 'project-123', text: 'working', owner }, { current: 1, size: 10 });

      const query = rankedIdsQuery();
      expect(query.sql).toContain('m."projectId" = ?');
      expect(query.sql).toContain('m."ownerKey" = ?');
      expect(query.values).toEqual(expect.arrayContaining(['project-123', OWNER_KEY]));
    });

    it('AC-3: the ranked path answers the owner rows only when scope user is asked', async () => {
      rankedOne();

      await repository.findByProjectMemory({ projectId: 'project-123', text: 'working', scope: 'user', owner }, { current: 1, size: 10 });

      const query = rankedIdsQuery();
      expect(query.sql).not.toContain('m."projectId" = ?');
      expect(query.sql).toContain('m."ownerKey" = ?');
      expect(query.values).toContain(OWNER_KEY);
    });
  });
});

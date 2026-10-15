import { PrismaCommentRepository } from './prisma-comment.repository';

describe('PrismaCommentRepository', () => {
  const mockTxManager = {
    run: vi.fn((fn: () => Promise<unknown>) => fn()),
    getClient: vi.fn(),
    isInTransaction: vi.fn(() => false),
  };

  const mockFindMany = vi.fn();
  const mockCount = vi.fn();
  const mockPrisma = {
    client: {
      comment: {
        findMany: mockFindMany,
        count: mockCount,
      },
    },
  };

  let repo: PrismaCommentRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = new PrismaCommentRepository(mockTxManager as never, mockPrisma as never);
  });

  it('findByTicketId returns domain comments ordered by createdAt asc', async () => {
    const createdAt = new Date('2026-05-02T10:00:00.000Z');
    const updatedAt = new Date('2026-05-02T10:01:00.000Z');
    mockFindMany.mockResolvedValue([
      {
        id: 'c1',
        ticketId: 't1',
        body: 'hello',
        type: 'GENERAL',
        authorUserId: 'u1',
        authorAgentId: null,
        createdAt,
        updatedAt,
      },
    ]);

    const result = await repo.findByTicketId('t1');

    expect(mockFindMany).toHaveBeenCalledWith({
      where: { ticketId: 't1' },
      orderBy: { createdAt: 'asc' },
    });
    expect(result).toEqual([
      {
        id: 'c1',
        ticketId: 't1',
        body: 'hello',
        type: 'GENERAL',
        authorUserId: 'u1',
        authorAgentId: null,
        createdAt,
        updatedAt,
      },
    ]);
  });

  // US-003 fix F1: the koda tool's comment read must be bounded by `take`, so a
  // ticket with a long history never loads every row.
  it('findRecentByTicketId asks for only the newest `limit` comments and returns them oldest first', async () => {
    const createdAt = (second: number) => new Date(`2026-05-02T10:00:${String(second).padStart(2, '0')}.000Z`);
    const row = (id: string, second: number) => ({
      id,
      ticketId: 't1',
      body: `body ${id}`,
      type: 'GENERAL',
      authorUserId: 'u1',
      authorAgentId: null,
      createdAt: createdAt(second),
      updatedAt: createdAt(second),
    });
    // Newest first, exactly as the query orders them.
    mockFindMany.mockResolvedValue([row('c3', 2), row('c2', 1), row('c1', 0)]);

    const result = await repo.findRecentByTicketId('t1', 10);

    expect(mockFindMany).toHaveBeenCalledWith({
      where: { ticketId: 't1' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 10,
    });
    expect(result.map((comment) => comment.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('countByTicketId counts the comments of one ticket', async () => {
    mockCount.mockResolvedValue(12);

    expect(await repo.countByTicketId('t1')).toBe(12);
    expect(mockCount).toHaveBeenCalledWith({ where: { ticketId: 't1' } });
  });
});

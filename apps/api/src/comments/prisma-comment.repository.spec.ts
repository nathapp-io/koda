import { PrismaCommentRepository } from './prisma-comment.repository';

describe('PrismaCommentRepository', () => {
  const mockTxManager = {
    run: jest.fn((fn: () => Promise<unknown>) => fn()),
    getClient: jest.fn(),
    isInTransaction: jest.fn(() => false),
  };

  const mockFindMany = jest.fn();
  const mockPrisma = {
    client: {
      comment: {
        findMany: mockFindMany,
      },
    },
  };

  let repo: PrismaCommentRepository;

  beforeEach(() => {
    jest.clearAllMocks();
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
});

import { PrismaVcsRepository } from './prisma-vcs.repository';

describe('PrismaVcsRepository', () => {
  const mockRun = jest.fn((fn: () => Promise<unknown>) => fn());
  const mockTxManager = {
    run: mockRun,
    getClient: jest.fn(),
    isInTransaction: jest.fn(() => false),
  };

  const mockFindFirst = jest.fn();
  const mockCreate = jest.fn();
  const mockFindMany = jest.fn();
  const mockUpdate = jest.fn();
  const mockCommentCreate = jest.fn();
  const mockActivityCreate = jest.fn();

  const mockPrisma = {
    client: {
      ticket: { findFirst: mockFindFirst, create: mockCreate, update: mockUpdate },
      ticketLink: { findMany: mockFindMany, update: mockUpdate },
      comment: { create: mockCommentCreate },
      ticketActivity: { create: mockActivityCreate },
    },
  };

  let repo: PrismaVcsRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new PrismaVcsRepository(mockTxManager as never, mockPrisma as never);
  });

  it('createTicketFromIssue allocates next number in txManager.run', async () => {
    mockFindFirst.mockResolvedValue({ number: 7 });
    mockCreate.mockResolvedValue({ id: 't1', number: 8, title: 'Issue title' });

    const result = await repo.createTicketFromIssue(
      { id: 'p1' } as never,
      { number: 99, title: 'Issue title', body: 'Issue body', url: 'http://gh/issue/99' } as never,
    );

    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: 'p1',
          number: 8,
          externalVcsId: '99',
          externalVcsUrl: 'http://gh/issue/99',
        }),
      }),
    );
    expect(result).toEqual({ id: 't1', number: 8, title: 'Issue title' });
  });

  it('findActiveTicketLinksWithPrs filters merged/closed and null deleted tickets', async () => {
    mockFindMany.mockResolvedValue([]);
    await repo.findActiveTicketLinksWithPrs('p1');

    expect(mockFindMany).toHaveBeenCalledWith({
      include: {
        ticket: {
          select: {
            id: true,
            status: true,
            projectId: true,
            number: true,
            externalVcsId: true,
          },
        },
      },
      where: {
        prNumber: { not: null },
        prState: { notIn: ['merged', 'closed'] },
        ticket: {
          projectId: 'p1',
          deletedAt: null,
        },
      },
    });
  });

  it('applyMergedPrTransition writes ticket, comment and activity in txManager.run', async () => {
    await repo.applyMergedPrTransition({
      ticketId: 't1',
      externalRef: null,
      prUrl: 'http://gh/pr/1',
      mergedBy: 'alice',
      mergeSha: 'abc123',
    });

    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { status: 'VERIFY_FIX' },
    });
    expect(mockCommentCreate).toHaveBeenCalled();
    expect(mockActivityCreate).toHaveBeenCalled();
  });
});

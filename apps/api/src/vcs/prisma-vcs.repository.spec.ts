import { PrismaVcsRepository } from './prisma-vcs.repository';

describe('PrismaVcsRepository', () => {
  const mockRun = vi.fn((fn: () => Promise<unknown>) => fn());
  const mockTxManager = {
    run: mockRun,
    getClient: vi.fn(),
    isInTransaction: vi.fn(() => false),
  };

  const mockFindFirst = vi.fn();
  const mockCreate = vi.fn();
  const mockFindMany = vi.fn();
  const mockUpdate = vi.fn();
  const mockCommentCreate = vi.fn();
  const mockActivityCreate = vi.fn();

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
    vi.clearAllMocks();
    repo = new PrismaVcsRepository(mockTxManager as never, mockPrisma as never);
  });

  it('createTicketFromIssue allocates next number in txManager.run', async () => {
    mockFindFirst.mockResolvedValue({ number: 7 });
    mockCreate.mockResolvedValue({ id: 't1', number: 8, title: 'Issue title' });

    const result = await repo.createTicketFromIssue(
      { id: 'p1' } as never,
      { number: 99, title: 'Issue title', body: 'Issue body', url: 'http://gh/issue/99' } as never,
      'acme/widgets#99',
    );

    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: 'p1',
          number: 8,
          externalVcsId: 'acme/widgets#99',
          externalVcsUrl: 'http://gh/issue/99',
        }),
      }),
    );
    expect(result).toEqual({ id: 't1', number: 8, title: 'Issue title' });
  });

  it('findActiveTicketLinksWithPrs filters merged/closed and null deleted tickets', async () => {
    mockFindMany.mockResolvedValue([]);
    await repo.findActiveTicketLinksWithPrs('p1', { repoOwner: 'acme', repoName: 'app' });

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

  it('findActiveTicketLinksWithPrs drops links of other repos (D458)', async () => {
    mockFindMany.mockResolvedValue([
      { id: 'mine', externalRef: 'acme/app#5', prNumber: 5, source: 'vcs' },
      { id: 'other', externalRef: 'other/lib#5', prNumber: 5, source: 'fleet' },
      { id: 'legacy', externalRef: null, prNumber: 6, source: 'vcs' },
    ]);
    const rows = await repo.findActiveTicketLinksWithPrs('p1', { repoOwner: 'acme', repoName: 'app' });
    expect(rows.map((r) => r.id)).toEqual(['mine', 'legacy']);
  });

  it('findTicketLinkForConnectionPr returns the connection repo link, not another repo with the same number', async () => {
    mockFindMany.mockResolvedValue([
      { id: 'other', externalRef: 'other/lib#5', prNumber: 5, source: 'fleet' },
      { id: 'mine', externalRef: 'ACME/App#5', prNumber: 5, source: 'vcs' },
    ]);
    const row = await repo.findTicketLinkForConnectionPr('p1', { repoOwner: 'acme', repoName: 'app' }, 5);
    expect(row?.id).toBe('mine');
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { prNumber: 5, ticket: { projectId: 'p1' } } }));
  });

  it('findTicketLinkForConnectionPr returns null when only another repo has that number', async () => {
    mockFindMany.mockResolvedValue([{ id: 'other', externalRef: 'other/lib#5', prNumber: 5, source: 'fleet' }]);
    await expect(repo.findTicketLinkForConnectionPr('p1', { repoOwner: 'acme', repoName: 'app' }, 5)).resolves.toBeNull();
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

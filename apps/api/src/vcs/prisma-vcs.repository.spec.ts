import { PrismaVcsRepository } from './prisma-vcs.repository';
import { currentBookkeepingReason } from '../action-context/audit-coverage';

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
  const mockQueryRaw = vi.fn();

  const mockPrisma = {
    client: {
      ticket: { findFirst: mockFindFirst, create: mockCreate, update: mockUpdate },
      ticketLink: { findMany: mockFindMany, update: mockUpdate, upsert: vi.fn(), create: vi.fn(), findFirst: vi.fn() },
      comment: { create: mockCommentCreate },
      ticketActivity: { create: mockActivityCreate },
      $queryRaw: mockQueryRaw,
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

  it('createTicketFromIssue awaits onCreated after the insert, inside the attempt', async () => {
    mockFindFirst.mockResolvedValue(null);
    mockCreate.mockResolvedValue({ id: 't1', number: 1, title: 'Issue title' });
    const onCreated = vi.fn(async () => undefined);

    const result = await repo.createTicketFromIssue(
      { id: 'p1' } as never,
      { number: 99, title: 'Issue title', body: null, url: 'http://gh/issue/99' } as never,
      'acme/widgets#99',
      onCreated,
    );

    expect(onCreated).toHaveBeenCalledWith({ id: 't1', number: 1 });
    expect(onCreated.mock.invocationCallOrder[0]).toBeGreaterThan(mockCreate.mock.invocationCallOrder[0]);
    expect(result).toEqual({ id: 't1', number: 1, title: 'Issue title' });
  });

  it('AC-28: a rejecting onCreated propagates without being retried as a number conflict', async () => {
    mockFindFirst.mockResolvedValue(null);
    mockCreate.mockResolvedValue({ id: 't1', number: 1, title: 'Issue title' });
    const onCreated = vi.fn(async () => {
      throw new Error('audit down');
    });

    await expect(
      repo.createTicketFromIssue(
        { id: 'p1' } as never,
        { number: 99, title: 'Issue title', body: null, url: 'http://gh/issue/99' } as never,
        'acme/widgets#99',
        onCreated,
      ),
    ).rejects.toThrow('audit down');

    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);
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

  describe('US-008 bookkeeping marks', () => {
    it('marks same-state PR updates only', async () => {
      mockQueryRaw.mockResolvedValue([{ prState: 'open' }]);
      const reasons: unknown[] = [];
      mockUpdate.mockImplementation(async () => { reasons.push(currentBookkeepingReason()); return {}; });
      await repo.updateTicketLinkWithPrState('link-1', 'open');
      expect(reasons).toEqual(['vcs.pr-same-state']);

      mockUpdate.mockClear();
      mockQueryRaw.mockResolvedValue([{ prState: 'open' }]);
      await repo.updateTicketLinkWithPrState('link-1', 'closed');
      expect(reasons).toEqual(['vcs.pr-same-state', undefined]);
    });

    it('marks existing link refresh but not a new link create', async () => {
      const ticketLink = mockPrisma.client.ticketLink;
      const reasons: unknown[] = [];
      ticketLink.upsert.mockImplementation(async () => { reasons.push(currentBookkeepingReason()); return {}; });
      ticketLink.findFirst.mockResolvedValue({ id: 'existing' });
      await repo.upsertTicketLink('t1', 'https://x', 'github', 'commit');
      expect(reasons).toEqual(['vcs.link-refresh']);
      ticketLink.findFirst.mockResolvedValue(null);
      ticketLink.create.mockImplementation(async () => { reasons.push(currentBookkeepingReason()); return { id: 'new' }; });
      await repo.upsertTicketLink('t1', 'https://y', 'github', 'commit');
      expect(reasons).toEqual(['vcs.link-refresh', undefined]);
    });
  });

  describe('updateTicketLinkWithPrState (review B1)', () => {
    const lockedSql = () => String((mockQueryRaw.mock.calls[0][0] as TemplateStringsArray).join('?'));

    it('reports the state its locked read returned, not a state from before the transaction', async () => {
      mockQueryRaw.mockResolvedValue([{ prState: 'draft' }]);

      await expect(repo.updateTicketLinkWithPrState('link-1', 'open'))
        .resolves.toEqual({ result: 'updated', previousState: 'draft' });

      expect(lockedSql()).toContain('FOR UPDATE');
      expect(mockRun).toHaveBeenCalledTimes(1);
      expect(mockQueryRaw.mock.invocationCallOrder[0]).toBeLessThan(mockUpdate.mock.invocationCallOrder[0]);
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'link-1' },
        data: { prState: 'open', prUpdatedAt: expect.any(Date) },
      });
    });

    it('reports a state it will not overwrite, and merged stays terminal', async () => {
      mockQueryRaw.mockResolvedValue([{ prState: 'merged' }]);

      await expect(repo.updateTicketLinkWithPrState('link-1', 'open'))
        .resolves.toEqual({ result: 'already-merged', previousState: 'merged' });
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('reports a vanished link as not-found with no previous state and no write', async () => {
      mockQueryRaw.mockResolvedValue([]);

      await expect(repo.updateTicketLinkWithPrState('gone', 'open'))
        .resolves.toEqual({ result: 'not-found', previousState: null });
      expect(mockUpdate).not.toHaveBeenCalled();
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

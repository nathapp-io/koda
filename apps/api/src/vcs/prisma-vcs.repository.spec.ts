import { PrismaVcsRepository } from './prisma-vcs.repository';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { Prisma } from '../generated/prisma/client';
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
  const mockUpdateMany = vi.fn();
  const mockCommentCreate = vi.fn();
  const mockActivityCreate = vi.fn();
  const mockQueryRaw = vi.fn();
  // Review P2 remainder (US-002): the connection reads and the bulk deactivation behind them.
  const mockVcsFindFirst = vi.fn();
  const mockVcsFindMany = vi.fn();
  const mockVcsUpdateManyAndReturn = vi.fn();

  const mockPrisma = {
    client: {
      ticket: { findFirst: mockFindFirst, create: mockCreate, update: mockUpdate, updateMany: mockUpdateMany },
      ticketLink: { findMany: mockFindMany, update: mockUpdate, upsert: vi.fn(), create: vi.fn(), findFirst: vi.fn() },
      comment: { create: mockCommentCreate },
      ticketActivity: { create: mockActivityCreate },
      vcsConnection: {
        update: vi.fn(),
        findFirst: mockVcsFindFirst,
        findMany: mockVcsFindMany,
        updateManyAndReturn: mockVcsUpdateManyAndReturn,
      },
      $queryRaw: mockQueryRaw,
    },
  };

  let repo: PrismaVcsRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryRaw.mockReset().mockResolvedValue([{ id: 'p1' }]);
    mockUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    mockTxManager.isInTransaction.mockReturnValue(false);
    repo = new PrismaVcsRepository(mockTxManager as never, mockPrisma as never);
  });

  it('refuses a connection lock outside a transaction', async () => {
    await expect(repo.findVcsConnectionByProjectId('p1', { lock: true })).rejects.toThrow('Connection locking requires an active transaction');
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it('reads a missing connection under FOR UPDATE in the caller transaction', async () => {
    mockTxManager.isInTransaction.mockReturnValue(true);
    mockQueryRaw.mockResolvedValue([]);
    expect(await repo.findVcsConnectionByProjectId('p1', { lock: true })).toBeNull();
    const [sql, projectId] = mockQueryRaw.mock.calls[0];
    expect(sql.join('?')).toContain('SELECT * FROM "VcsConnection" WHERE "projectId" = ? FOR UPDATE');
    expect(projectId).toBe('p1');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('refuses a stale import after the project was deleted, before allocation or audit', async () => {
    mockQueryRaw.mockResolvedValue([]);
    mockFindFirst.mockResolvedValue(null);
    mockCreate.mockResolvedValue({ id: 'late', number: 1, title: 'late issue' });
    const onCreated = vi.fn();
    await expect(repo.createTicketFromIssue(
      { id: 'p1' }, { number: 99, title: 'late issue', body: null, url: 'http://gh/99' } as never,
      'acme/widgets#99', onCreated,
    )).rejects.toThrow(NotFoundAppException);
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
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
    const [sql, projectId] = mockQueryRaw.mock.calls[0];
    expect(sql.join('?')).toContain('FROM "Project" WHERE "id" = ? AND "deletedAt" IS NULL FOR UPDATE');
    expect(projectId).toBe('p1');
    expect(mockQueryRaw.mock.invocationCallOrder[0]).toBeGreaterThan(mockRun.mock.invocationCallOrder[0]);
    expect(mockQueryRaw.mock.invocationCallOrder[0]).toBeLessThan(mockFindFirst.mock.invocationCallOrder[0]);
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
    // `vi.clearAllMocks()` clears call history only, so a reason recorder installed here would keep
    // running — and pushing into this test's local array — during the file's later tests.
    afterEach(() => {
      mockUpdate.mockReset();
      mockPrisma.client.ticketLink.upsert.mockReset();
      mockPrisma.client.ticketLink.create.mockReset();
    });

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

    it.each(['open', 'draft', 'merged'])('F1: compares the expected state under lock before writing %s', async (next) => {
      mockQueryRaw.mockResolvedValue([{ prState: 'closed' }]);
      await expect(repo.updateTicketLinkWithPrState('link-1', next, { expectedState: 'open' }))
        .resolves.toEqual({ result: 'state-changed', previousState: 'closed' });
      expect(lockedSql()).toContain('FOR UPDATE');
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('reports a vanished link as not-found with no previous state and no write', async () => {
      mockQueryRaw.mockResolvedValue([]);

      await expect(repo.updateTicketLinkWithPrState('gone', 'open'))
        .resolves.toEqual({ result: 'not-found', previousState: null });
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  it('F2: an ineligible current ticket creates no transition records', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });
    await expect(repo.applyMergedPrTransition({ ticketId: 't1', externalRef: null, prUrl: 'http://gh/pr/1', mergedBy: null, mergeSha: null })).resolves.toBe(false);
    expect(mockUpdateMany).toHaveBeenCalledWith({ where: { id: 't1', status: 'IN_PROGRESS', deletedAt: null }, data: { status: 'VERIFY_FIX' } });
    expect(mockCommentCreate).not.toHaveBeenCalled();
    expect(mockActivityCreate).not.toHaveBeenCalled();
  });

  it('applyMergedPrTransition writes ticket, comment and activity in txManager.run', async () => {
    const transitioned = await repo.applyMergedPrTransition({
      ticketId: 't1',
      externalRef: null,
      prUrl: 'http://gh/pr/1',
      mergedBy: 'alice',
      mergeSha: 'abc123',
    });

    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: 't1', status: 'IN_PROGRESS', deletedAt: null },
      data: { status: 'VERIFY_FIX' },
    });
    expect(transitioned).toBe(true);
    expect(mockCommentCreate).toHaveBeenCalled();
    expect(mockActivityCreate).toHaveBeenCalled();
  });

  describe('review P2 US-002: a soft-deleted project stops polling', () => {
    beforeEach(() => {
      mockVcsFindFirst.mockReset();
      mockVcsFindMany.mockReset();
      mockVcsUpdateManyAndReturn.mockReset();
    });

    it('deactivates the project active connections in one statement and answers their ids', async () => {
      mockVcsUpdateManyAndReturn.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);

      await expect(repo.deactivateConnectionsForProject('p1')).resolves.toEqual(['c1', 'c2']);

      expect(mockVcsUpdateManyAndReturn).toHaveBeenCalledExactlyOnceWith({
        where: { projectId: 'p1', isActive: true },
        data: { isActive: false },
        select: { id: true },
      });
    });

    it('answers no ids when the project has no active connection', async () => {
      mockVcsUpdateManyAndReturn.mockResolvedValue([]);

      await expect(repo.deactivateConnectionsForProject('p1')).resolves.toEqual([]);
    });

    it('reads a connection only while its project lives', async () => {
      mockVcsFindFirst.mockResolvedValue(null);

      await expect(repo.findVcsConnectionById('c1')).resolves.toBeNull();

      expect(mockVcsFindFirst).toHaveBeenCalledWith({
        where: { id: 'c1', project: { deletedAt: null } },
        include: { project: true },
      });
    });

    it('lists only the polling connections of live projects', async () => {
      mockVcsFindMany.mockResolvedValue([]);

      await expect(repo.findPollingConnections()).resolves.toEqual([]);

      expect(mockVcsFindMany).toHaveBeenCalledWith({
        where: { syncMode: 'polling', isActive: true, project: { deletedAt: null } },
        include: { project: true },
      });
    });
  });

  describe('updateVcsConnectionById (US-003 F1)', () => {
    const pinnedUpdate = mockPrisma.client.vcsConnection.update;
    const row = {
      id: 'c1', projectId: 'p1', provider: 'github', repoOwner: 'o', repoName: 'r', encryptedToken: 'e',
      syncMode: 'polling', allowedAuthors: '[]', pollingIntervalMs: 600000, webhookSecret: null,
      isActive: true, lastSyncedAt: null, createdAt: new Date(), updatedAt: new Date(),
    };

    beforeEach(() => {
      pinnedUpdate.mockReset();
    });

    it('pins the write to the connection id and the project, not the project alone', async () => {
      pinnedUpdate.mockResolvedValue(row);

      const written = await repo.updateVcsConnectionById('c1', 'p1', { syncMode: 'polling' });

      expect(pinnedUpdate).toHaveBeenCalledExactlyOnceWith({
        where: { id: 'c1', projectId: 'p1' },
        data: { syncMode: 'polling' },
      });
      expect(written?.id).toBe('c1');
    });

    it('answers null when the pinned row is gone, so the caller can refuse with 404', async () => {
      pinnedUpdate.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('Record to update not found', {
        code: 'P2025', clientVersion: 'test',
      }));

      await expect(repo.updateVcsConnectionById('gone', 'p1', { syncMode: 'polling' })).resolves.toBeNull();
    });

    it('rethrows any other write failure', async () => {
      pinnedUpdate.mockRejectedValue(new Error('connection reset'));

      await expect(repo.updateVcsConnectionById('c1', 'p1', { syncMode: 'polling' }))
        .rejects.toThrow('connection reset');
    });

    it('leaves the legacy project-scoped write unchanged', async () => {
      pinnedUpdate.mockResolvedValue(row);

      await repo.updateVcsConnection('p1', { syncMode: 'polling' });

      expect(pinnedUpdate).toHaveBeenCalledExactlyOnceWith({ where: { projectId: 'p1' }, data: { syncMode: 'polling' } });
    });
  });
});

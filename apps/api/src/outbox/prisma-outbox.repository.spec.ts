import { PrismaOutboxRepository } from './prisma-outbox.repository';

describe('PrismaOutboxRepository', () => {
  const mockTxManager = {
    run: jest.fn((fn: () => Promise<unknown>) => fn()),
    getClient: jest.fn(),
    isInTransaction: jest.fn(() => false),
  };

  const mockFindUnique = jest.fn();
  const mockFindMany = jest.fn();
  const mockUpdateMany = jest.fn();
  const mockPrisma = {
    client: {
      outboxEvent: {
        findUnique: mockFindUnique,
        findMany: mockFindMany,
        updateMany: mockUpdateMany,
      },
    },
  };

  let repo: PrismaOutboxRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new PrismaOutboxRepository(mockTxManager as never, mockPrisma as never);
  });

  describe('findById', () => {
    it('maps the found model to the domain shape', async () => {
      const now = new Date('2026-09-26T10:00:00.000Z');
      mockFindUnique.mockResolvedValue({
        id: 'o1',
        projectId: 'p1',
        type: 'ticket_event',
        eventId: 'e1',
        payload: '{}',
        headers: null,
        status: 'dead',
        attempts: 3,
        nextAttemptAt: now,
        leaseUntil: null,
        owner: null,
        lastError: 'boom',
        publishedAt: null,
        createdAt: now,
        updatedAt: now,
      });

      const result = await repo.findById('o1');

      expect(mockFindUnique).toHaveBeenCalledWith({ where: { id: 'o1' } });
      expect(result).toMatchObject({ id: 'o1', type: 'ticket_event', status: 'dead', nextAttemptAt: now });
    });

    it('returns null when the row does not exist', async () => {
      mockFindUnique.mockResolvedValue(null);

      const result = await repo.findById('missing');

      expect(result).toBeNull();
    });
  });

  describe('findByStatus', () => {
    it('queries by status, ordered createdAt asc, limited', async () => {
      mockFindMany.mockResolvedValue([]);
      await repo.findByStatus('pending', 42);

      expect(mockFindMany).toHaveBeenCalledWith({
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' },
        take: 42,
      });
    });

    it('maps models to the domain shape', async () => {
      const now = new Date('2026-09-26T10:00:00.000Z');
      mockFindMany.mockResolvedValue([
        {
          id: 'o1',
          projectId: 'p1',
          type: 'ticket_event',
          eventId: 'e1',
          payload: '{}',
          headers: null,
          status: 'dead',
          attempts: 3,
          nextAttemptAt: now,
          leaseUntil: null,
          owner: null,
          lastError: 'boom',
          publishedAt: null,
          createdAt: now,
          updatedAt: now,
        },
      ]);

      const result = await repo.findByStatus('dead', 10);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ id: 'o1', type: 'ticket_event', status: 'dead', nextAttemptAt: now });
    });
  });

  describe('resetForRetry', () => {
    it('only targets dead/pending rows and sends pending/due-now/lease-and-error-cleared data, returning count', async () => {
      mockUpdateMany.mockResolvedValue({ count: 1 });
      const now = new Date('2026-09-26T11:00:00.000Z');

      const count = await repo.resetForRetry('o1', now);

      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { id: 'o1', status: { in: ['dead', 'pending'] } },
        data: { status: 'pending', attempts: 0, nextAttemptAt: now, owner: null, leaseUntil: null, lastError: null },
      });
      expect(count).toBe(1);
    });

    it('returns 0 when the row is missing or not in a retryable status', async () => {
      mockUpdateMany.mockResolvedValue({ count: 0 });

      const count = await repo.resetForRetry('missing', new Date());

      expect(count).toBe(0);
    });
  });

  describe('recordLastError', () => {
    it('writes lastError with updateMany so a missing row is a no-op', async () => {
      mockUpdateMany.mockResolvedValue({ count: 0 });

      await repo.recordLastError('o1', '1 fan-out handler(s) failed');

      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { id: 'o1' },
        data: { lastError: '1 fan-out handler(s) failed' },
      });
    });
  });
});

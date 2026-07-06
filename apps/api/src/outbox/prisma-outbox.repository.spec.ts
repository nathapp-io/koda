import { PrismaOutboxRepository } from './prisma-outbox.repository';

describe('PrismaOutboxRepository', () => {
  const mockTxManager = {
    run: jest.fn((fn: () => Promise<unknown>) => fn()),
    getClient: jest.fn(),
    isInTransaction: jest.fn(() => false),
  };

  const mockCreate = jest.fn();
  const mockFindMany = jest.fn();
  const mockUpdateMany = jest.fn();
  const mockUpdate = jest.fn();
  const mockPrisma = {
    client: {
      outboxEvent: {
        create: mockCreate,
        findMany: mockFindMany,
        updateMany: mockUpdateMany,
        update: mockUpdate,
      },
    },
  };

  let repo: PrismaOutboxRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new PrismaOutboxRepository(mockTxManager as never, mockPrisma as never);
  });

  it('enqueue persists pending event and stringifies payload', async () => {
    const now = new Date('2026-05-02T11:00:00.000Z');
    mockCreate.mockResolvedValue({
      id: 'o1',
      projectId: 'p1',
      eventType: 'ticket.created',
      eventId: 'e1',
      payload: '{"ok":true}',
      status: 'pending',
      attempts: 0,
      lastError: null,
      processedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const result = await repo.enqueue({
      projectId: 'p1',
      eventType: 'ticket.created',
      eventId: 'e1',
      payload: { ok: true },
    });

    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        projectId: 'p1',
        eventType: 'ticket.created',
        eventId: 'e1',
        payload: '{"ok":true}',
        status: 'pending',
      },
    });
    expect(result.id).toBe('o1');
  });

  it('findPending queries pending events that are due, ordered by createdAt asc', async () => {
    mockFindMany.mockResolvedValue([]);
    await repo.findPending(50);

    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        status: 'pending',
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: expect.any(Date) } }],
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
  });

  it('claimForProcessing updates only pending event and returns count', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });
    const count = await repo.claimForProcessing('o1');

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: 'o1', status: 'pending' },
      data: { status: 'processing' },
    });
    expect(count).toBe(1);
  });

  describe('markFailed', () => {
    it('sets a future nextAttemptAt when requeuing to pending', async () => {
      mockUpdate.mockResolvedValue({});
      const before = Date.now();

      await repo.markFailed('o1', 'boom', 1, 'pending');

      expect(mockUpdate).toHaveBeenCalledTimes(1);
      const { where, data } = mockUpdate.mock.calls[0][0];
      expect(where).toEqual({ id: 'o1' });
      expect(data.attempts).toBe(1);
      expect(data.lastError).toBe('boom');
      expect(data.status).toBe('pending');
      // attempts=1 is the first failure (pre-increment attempt 0) -> OUTBOX_BACKOFF_MS(0) = 1000ms
      expect(data.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 1000);
      expect(data.nextAttemptAt.getTime()).toBeLessThan(before + 2000);
    });

    it('clears nextAttemptAt when transitioning to dead_letter', async () => {
      mockUpdate.mockResolvedValue({});

      await repo.markFailed('o1', 'boom', 3, 'dead_letter');

      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'o1' },
        data: {
          attempts: 3,
          lastError: 'boom',
          status: 'dead_letter',
          nextAttemptAt: null,
        },
      });
    });
  });
});

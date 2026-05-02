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
  const mockPrisma = {
    client: {
      outboxEvent: {
        create: mockCreate,
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

  it('findPending queries pending events ordered by createdAt asc', async () => {
    mockFindMany.mockResolvedValue([]);
    await repo.findPending(50);

    expect(mockFindMany).toHaveBeenCalledWith({
      where: { status: 'pending' },
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
});

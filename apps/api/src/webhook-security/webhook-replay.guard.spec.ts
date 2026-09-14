import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma } from '@prisma/client';
import { WebhookReplayGuard } from './webhook-replay.guard';

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '0',
  });
}

describe('WebhookReplayGuard', () => {
  let guard: WebhookReplayGuard;

  const findUniqueMock = jest.fn();
  const createMock = jest.fn();
  const deleteManyMock = jest.fn();

  const prismaMock = {
    client: {
      webhookDelivery: {
        findUnique: findUniqueMock,
        create: createMock,
        deleteMany: deleteManyMock,
      },
    },
  };

  beforeEach(async () => {
    findUniqueMock.mockReset().mockResolvedValue(null);
    createMock.mockReset().mockResolvedValue({ id: 'delivery-row-1' });
    deleteManyMock.mockReset().mockResolvedValue({ count: 1 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookReplayGuard,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    guard = module.get<WebhookReplayGuard>(WebhookReplayGuard);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('rejects when deliveryId is missing', async () => {
    await expect(
      guard.assertFresh({ projectId: 'p1', source: 'github' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it('accepts a fresh delivery and persists it', async () => {
    await guard.assertFresh({ projectId: 'p1', source: 'github', deliveryId: 'd1' });

    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { projectId_source_deliveryId: { projectId: 'p1', source: 'github', deliveryId: 'd1' } },
      select: { id: true },
    });
    expect(createMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ projectId: 'p1', source: 'github', deliveryId: 'd1' }),
    });
  });

  it('rejects a persisted duplicate with 409 (cross-instance replay)', async () => {
    findUniqueMock.mockResolvedValueOnce({ id: 'existing' });

    await expect(
      guard.assertFresh({ projectId: 'p1', source: 'github', deliveryId: 'd1' }),
    ).rejects.toMatchObject({ status: 409 });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('rejects a concurrent duplicate via unique violation with 409', async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    createMock.mockRejectedValueOnce(uniqueViolation());

    await expect(
      guard.assertFresh({ projectId: 'p1', source: 'github', deliveryId: 'd1' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('rethrows DB outages (non-P2002) so senders can retry instead of 409 (BUG-16)', async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    const dbDown = new Error('Connection refused');
    (dbDown as { code?: string }).code = 'P1001';
    createMock.mockRejectedValueOnce(dbDown);

    await expect(
      guard.assertFresh({ projectId: 'p1', source: 'github', deliveryId: 'd1' }),
    ).rejects.toThrow('Connection refused');
  });

  it('rethrows unknown errors from findUnique so they surface as 5xx (BUG-16)', async () => {
    findUniqueMock.mockRejectedValueOnce(new Error('db down'));

    await expect(
      guard.assertFresh({ projectId: 'p1', source: 'github', deliveryId: 'd1' }),
    ).rejects.toThrow('db down');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('rejects an immediate in-memory replay with 409 without hitting the DB twice', async () => {
    await guard.assertFresh({ projectId: 'p1', source: 'ci', deliveryId: 'd2' });

    await expect(
      guard.assertFresh({ projectId: 'p1', source: 'ci', deliveryId: 'd2' }),
    ).rejects.toMatchObject({ status: 409 });
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
  });

  it('accepts the same delivery id again for a different project or source', async () => {
    await guard.assertFresh({ projectId: 'p1', source: 'github', deliveryId: 'd3' });

    await expect(
      guard.assertFresh({ projectId: 'p2', source: 'github', deliveryId: 'd3' }),
    ).resolves.toBeUndefined();
    await expect(
      guard.assertFresh({ projectId: 'p1', source: 'ci', deliveryId: 'd3' }),
    ).resolves.toBeUndefined();
  });

  it('rejects a delivery outside the 5-minute window (stale Date header)', async () => {
    const stale = new Date(Date.now() - 10 * 60 * 1000).toUTCString();

    await expect(
      guard.assertFresh({ projectId: 'p1', source: 'github', deliveryId: 'd4', dateHeader: stale }),
    ).rejects.toMatchObject({ status: 400 });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('accepts a delivery with a fresh Date header', async () => {
    const fresh = new Date().toUTCString();

    await expect(
      guard.assertFresh({ projectId: 'p1', source: 'ci', deliveryId: 'd5', dateHeader: fresh }),
    ).resolves.toBeUndefined();
  });

  it('forget removes the persisted delivery so retries are accepted', async () => {
    await guard.assertFresh({ projectId: 'p1', source: 'github', deliveryId: 'd6' });
    await guard.forget({ projectId: 'p1', source: 'github', deliveryId: 'd6' });

    expect(deleteManyMock).toHaveBeenCalledWith({
      where: { projectId: 'p1', source: 'github', deliveryId: 'd6' },
    });

    findUniqueMock.mockResolvedValueOnce(null);
    await expect(
      guard.assertFresh({ projectId: 'p1', source: 'github', deliveryId: 'd6' }),
    ).resolves.toBeUndefined();
  });

  it('forget is a no-op when deliveryId is missing', async () => {
    await guard.forget({ projectId: 'p1', source: 'ci' });
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it('accepts a retried delivery after the in-memory window expires (BUG-18)', async () => {
    jest.useFakeTimers();
    try {
      await guard.assertFresh({ projectId: 'p1', source: 'ci', deliveryId: 'd9' });
      jest.advanceTimersByTime(6 * 60 * 1000);
      findUniqueMock.mockResolvedValueOnce(null);
      createMock.mockResolvedValueOnce({ id: 'delivery-row-2' });

      await expect(
        guard.assertFresh({ projectId: 'p1', source: 'ci', deliveryId: 'd9' }),
      ).resolves.toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('propagates unexpected DB errors as-is so they surface as 5xx, not 409 (BUG-16)', async () => {
    findUniqueMock.mockRejectedValueOnce(new Error('db down'));

    const err = await guard
      .assertFresh({ projectId: 'p1', source: 'github', deliveryId: 'd7' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as HttpException).getStatus?.()).toBeUndefined();
    expect((err as Error).message).toBe('db down');
  });
});
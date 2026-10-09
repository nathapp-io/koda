import { NotificationsRepository } from './notifications.repository';
import type { NotificationDraft } from './notification.types';

const draft = (over: Partial<NotificationDraft> = {}): NotificationDraft => ({
  userId: 'u1', projectId: 'p1', category: 'ASSIGNED', kind: 'ticket_assigned', title: 't', body: null,
  link: '/p/tickets/PP-1', params: { ref: 'PP-1' }, sourceType: 'ticket_event', sourceId: 'e1', actorId: 'u2', ...over,
});

function setup() {
  const insertedRow = { id: 'n1', userId: 'u1', category: 'ASSIGNED', kind: 'ticket_assigned', createdAt: new Date('2026-10-01T00:00:00Z') };
  const notification = {
    createManyAndReturn: jest.fn().mockResolvedValue([insertedRow]),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
  };
  const repo = new NotificationsRepository({ client: { notification } } as never);
  return { repo, notification, insertedRow };
}

describe('NotificationsRepository (S4a §1)', () => {
  it('US-002: inserts with skipDuplicates and returns id, userId, category, kind and createdAt', async () => {
    const { repo, notification, insertedRow } = setup();
    await expect(repo.insertMany([draft()])).resolves.toEqual([insertedRow]);
    expect(notification.createManyAndReturn).toHaveBeenCalledWith({
      data: [expect.objectContaining({ userId: 'u1', sourceType: 'ticket_event', sourceId: 'e1', kind: 'ticket_assigned', params: { ref: 'PP-1' } })],
      skipDuplicates: true,
      select: { id: true, userId: true, category: true, kind: true, createdAt: true },
    });
  });

  it('does not touch the database for an empty batch', async () => {
    const { repo, notification } = setup();
    await expect(repo.insertMany([])).resolves.toEqual([]);
    expect(notification.createManyAndReturn).not.toHaveBeenCalled();
  });

  it('pages newest first, filtering unread when asked', async () => {
    const { repo, notification } = setup();
    await repo.page('u1', { unreadOnly: true, page: 3, limit: 10 });
    expect(notification.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1', readAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 20,
      take: 10,
      select: expect.any(Object),
    });
    expect(notification.count).toHaveBeenCalledWith({ where: { userId: 'u1', readAt: null } });
  });

  it('markRead is owner-scoped and idempotent', async () => {
    const { repo, notification } = setup();
    const now = new Date('2026-10-09T00:00:00Z');
    notification.updateMany.mockResolvedValueOnce({ count: 0 });
    notification.count.mockResolvedValueOnce(1);
    await expect(repo.markRead('u1', 'n1', now)).resolves.toBe(true);
    expect(notification.updateMany).toHaveBeenCalledWith({ where: { id: 'n1', userId: 'u1', readAt: null }, data: { readAt: now } });
    expect(notification.count).toHaveBeenCalledWith({ where: { id: 'n1', userId: 'u1' } });
    notification.updateMany.mockResolvedValueOnce({ count: 0 });
    notification.count.mockResolvedValueOnce(0);
    await expect(repo.markRead('u1', 'not-mine', now)).resolves.toBe(false);
  });

  it('markAllRead marks only rows created at or before the cutoff', async () => {
    const { repo, notification } = setup();
    const cutoff = new Date('2026-10-09T00:00:00Z');
    notification.updateMany.mockResolvedValueOnce({ count: 4 });
    await expect(repo.markAllRead('u1', cutoff)).resolves.toBe(4);
    expect(notification.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', readAt: null, createdAt: { lte: cutoff } },
      data: { readAt: cutoff },
    });
  });

  it('purgeRead deletes rows read before the cutoff only (D511)', async () => {
    const { repo, notification } = setup();
    const before = new Date('2026-07-01T00:00:00Z');
    await expect(repo.purgeRead(before)).resolves.toBe(3);
    expect(notification.deleteMany).toHaveBeenCalledWith({ where: { readAt: { lt: before } } });
  });
});

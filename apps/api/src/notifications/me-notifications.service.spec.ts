import { NotFoundAppException } from '@nathapp/nestjs-common';
import { MeNotificationsService } from './me-notifications.service';

const row = {
  id: 'n1', userId: 'u1', projectId: 'p1', category: 'ASSIGNED', kind: 'ticket_assigned', title: 'T', body: null,
  link: '/koda/tickets/KODA-1', params: { ref: 'KODA-1' }, actorId: 'u2', readAt: null, createdAt: new Date('2026-10-09T01:00:00Z'),
};

function setup() {
  const repo = {
    page: jest.fn().mockResolvedValue({ items: [row], total: 21 }),
    unreadCount: jest.fn().mockResolvedValue(3),
    markRead: jest.fn().mockResolvedValue(true),
    markAllRead: jest.fn().mockResolvedValue(2),
  };
  return { repo, service: new MeNotificationsService(repo as never) };
}

describe('MeNotificationsService (S4a §3)', () => {
  it('pages the caller\'s rows into the koda page envelope with ISO dates', async () => {
    const { service, repo } = setup();
    const page = await service.list('u1', { current: 2, size: 10, unreadOnly: true });
    expect(repo.page).toHaveBeenCalledWith('u1', { unreadOnly: true, page: 2, limit: 10 });
    expect(page).toEqual({
      total: 21, current: 2, size: 10, hasNext: true, hasPrev: true,
      records: [{
        id: 'n1', category: 'ASSIGNED', kind: 'ticket_assigned', title: 'T', body: null, link: '/koda/tickets/KODA-1',
        params: { ref: 'KODA-1' }, projectId: 'p1', actorId: 'u2', readAt: null, createdAt: '2026-10-09T01:00:00.000Z',
      }],
    });
  });

  it('counts unread', async () => {
    const { service } = setup();
    await expect(service.unreadCount('u1')).resolves.toEqual({ count: 3 });
  });

  it('marks one read, 404 when it is not the caller\'s', async () => {
    const { service, repo } = setup();
    await service.markRead('u1', 'n1');
    expect(repo.markRead).toHaveBeenCalledWith('u1', 'n1', expect.any(Date));
    repo.markRead.mockResolvedValueOnce(false);
    await expect(service.markRead('u1', 'other')).rejects.toBeInstanceOf(NotFoundAppException);
  });

  it('read-all cutoff: passes the given cutoff through unchanged (Review Focus 5)', async () => {
    const { service, repo } = setup();
    const cutoff = new Date('2026-10-09T02:00:00Z');
    await service.markAllRead('u1', cutoff);
    expect(repo.markAllRead).toHaveBeenCalledWith('u1', cutoff);
  });
});

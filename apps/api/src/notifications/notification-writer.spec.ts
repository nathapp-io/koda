import { NotificationWriter } from './notification-writer';
import { ticketDraft } from './ticket-notification-text';
import type { NotificationDraft } from './notification.types';
import { UserEventBus } from '../live/user-event-bus';

const draft = (userId: string, over: Partial<NotificationDraft> = {}): NotificationDraft => ({
  userId, projectId: 'p1', category: 'WATCHED_ACTIVITY', kind: 'ticket_commented', title: 't', body: null, link: '/l',
  params: {}, sourceType: 'ticket_event', sourceId: 'e1', actorId: 'actor', ...over,
});

function setup() {
  const order: string[] = [];
  const eligibility = { filter: jest.fn(async (d: readonly NotificationDraft[]) => d.filter((x) => x.userId !== 'ineligible')) };
  const preferences = { disabledUserIds: jest.fn(async () => new Set(['muted-pref'])) };
  const repo = {
    insertMany: jest.fn(async (d: readonly NotificationDraft[]) => {
      order.push('insert');
      return d.map((x, i) => ({ id: `n${i}`, userId: x.userId }));
    }),
  };
  const bus = new UserEventBus();
  jest.spyOn(bus, 'publish').mockImplementation(() => { order.push('publish'); });
  const writer = new NotificationWriter(eligibility as never, preferences as never, repo as never, bus);
  return { writer, eligibility, preferences, repo, bus, order };
}

describe('NotificationWriter (S4a §2.1)', () => {
  it('filters eligibility, then preferences per category, inserts, then publishes each inserted row', async () => {
    const { writer, preferences, repo, bus, order } = setup();
    const count = await writer.deliver([draft('a'), draft('ineligible'), draft('muted-pref'), draft('b', { category: 'ASSIGNED', kind: 'ticket_assigned' })]);
    expect(count).toBe(2);
    expect(preferences.disabledUserIds).toHaveBeenCalledWith(['a', 'muted-pref'], 'WATCHED_ACTIVITY', 'in_app');
    expect(preferences.disabledUserIds).toHaveBeenCalledWith(['b'], 'ASSIGNED', 'in_app');
    expect(repo.insertMany.mock.calls[0][0].map((d: NotificationDraft) => d.userId)).toEqual(['a', 'b']);
    expect(bus.publish).toHaveBeenCalledWith({ type: 'notification', userId: 'a', id: 'n0', at: expect.any(String) });
    expect(order).toEqual(['insert', 'publish', 'publish']);
  });

  it('publishes nothing when the insert added no rows (redelivery)', async () => {
    const { writer, repo, bus } = setup();
    repo.insertMany.mockResolvedValueOnce([]);
    await expect(writer.deliver([draft('a')])).resolves.toBe(0);
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('does nothing for no drafts', async () => {
    const { writer, eligibility } = setup();
    await expect(writer.deliver([])).resolves.toBe(0);
    expect(eligibility.filter).not.toHaveBeenCalled();
  });

  it('propagates a database failure so the outbox retries', async () => {
    const { writer, repo } = setup();
    repo.insertMany.mockRejectedValueOnce(new Error('db down'));
    await expect(writer.deliver([draft('a')])).rejects.toThrow('db down');
  });

  it('truncates: a draft built from a huge title and comment inserts without error (Review Focus 4)', async () => {
    const { writer, repo } = setup();
    const huge = ticketDraft({
      kind: 'ticket_commented', userId: 'a', eventId: 'e9', actorId: 'actor', projectId: 'p1', slug: 's', ref: 'S-1',
      ticketTitle: 'x'.repeat(5000), actorName: 'y'.repeat(300), excerpt: 'z'.repeat(100_000),
    });
    await expect(writer.deliver([huge])).resolves.toBe(1);
    const inserted = repo.insertMany.mock.calls[0][0][0] as NotificationDraft;
    expect(inserted.title.length).toBeLessThanOrEqual(200);
    expect((inserted.body ?? '').length).toBeLessThanOrEqual(280);
  });
});

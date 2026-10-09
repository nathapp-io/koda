import { NotificationWriter } from './notification-writer';
import { ticketDraft } from './ticket-notification-text';
import type { NotificationDraft } from './notification.types';
import { UserEventBus } from '../live/user-event-bus';

const CREATED_AT = new Date('2026-10-10T12:00:00.000Z');
const plusSec = (base: Date, sec: number) => new Date(base.getTime() + sec * 1000);

const draft = (userId: string, over: Partial<NotificationDraft> = {}): NotificationDraft => ({
  userId, projectId: 'p1', category: 'WATCHED_ACTIVITY', kind: 'ticket_commented', title: 't', body: null, link: '/l',
  params: {}, sourceType: 'ticket_event', sourceId: 'e1', actorId: 'actor', ...over,
});

function setup() {
  const order: string[] = [];
  const eligibility = { filter: jest.fn(async (d: readonly NotificationDraft[]) => d.filter((x) => x.userId !== 'ineligible')) };
  const preferences = {
    disabledUserIds: jest.fn(async () => new Set(['muted-pref'])),
    emailAllowedUserIds: jest.fn(async (userIds: readonly string[]) => new Set(userIds)),
  };
  const repo = {
    insertMany: jest.fn(async (d: readonly NotificationDraft[]) => {
      order.push('insert');
      return d.map((x, i) => ({ id: `n${i}`, userId: x.userId, category: x.category, kind: x.kind, createdAt: CREATED_AT }));
    }),
  };
  const bus = new UserEventBus();
  jest.spyOn(bus, 'publish').mockImplementation(() => { order.push('publish'); });
  const email = { configured: true };
  const schedule = {
    scheduleNotifications: jest.fn(async (rows: readonly unknown[]) => { order.push('schedule'); return rows.length; }),
  };
  const recipients = { emails: jest.fn(async (ids: readonly string[]) => new Map(ids.map((id) => [id, `${id}@example.com`]))) };
  const txManager = {
    run: jest.fn(async (fn: () => Promise<unknown>) => { order.push('tx-start'); try { return await fn(); } finally { order.push('tx-end'); } }),
    getClient: jest.fn(),
    isInTransaction: jest.fn(() => false),
  };
  const writer = new NotificationWriter(
    eligibility as never, preferences as never, repo as never, bus,
    email as never, schedule as never, recipients as never, txManager as never,
  );
  return { writer, eligibility, preferences, repo, bus, email, schedule, recipients, txManager, order };
}

describe('NotificationWriter (S4a §2.1)', () => {
  it('filters eligibility, then preferences per category, inserts, then publishes each inserted row', async () => {
    const { writer, preferences, repo, bus } = setup();
    const count = await writer.deliver([draft('a'), draft('ineligible'), draft('muted-pref'), draft('b', { category: 'ASSIGNED', kind: 'ticket_assigned' })]);
    expect(count).toBe(2);
    expect(preferences.disabledUserIds).toHaveBeenCalledWith(['a', 'muted-pref'], 'WATCHED_ACTIVITY', 'in_app');
    expect(preferences.disabledUserIds).toHaveBeenCalledWith(['b'], 'ASSIGNED', 'in_app');
    expect(repo.insertMany.mock.calls[0][0].map((d: NotificationDraft) => d.userId)).toEqual(['a', 'b']);
    expect(bus.publish).toHaveBeenCalledWith({ type: 'notification', userId: 'a', id: 'n0', at: expect.any(String) });
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

describe('NotificationWriter email scheduling (S4b US-002)', () => {
  it('US-002 AC16: schedules the inserted id and the user address at createdAt + EMAIL_DELAY_SEC', async () => {
    const { writer, schedule, recipients } = setup();
    await writer.deliver([draft('a', { category: 'ASSIGNED', kind: 'ticket_assigned' })]);
    expect(recipients.emails).toHaveBeenCalledWith(['a']);
    expect(schedule.scheduleNotifications).toHaveBeenCalledTimes(1);
    expect(schedule.scheduleNotifications.mock.calls[0][0]).toEqual([
      expect.objectContaining({ notificationId: 'n0', userId: 'a', toEmail: 'a@example.com', dueAt: plusSec(CREATED_AT, 300) }),
    ]);
  });

  it('US-002 AC17: an approval_requested notification uses EMAIL_APPROVAL_DELAY_SEC', async () => {
    const { writer, schedule } = setup();
    await writer.deliver([draft('a', { category: 'FLEET_NEEDS_YOU', kind: 'approval_requested' })]);
    expect(schedule.scheduleNotifications).toHaveBeenCalled();
    const [row] = schedule.scheduleNotifications.mock.calls[0][0] as Array<{ dueAt: Date }>;
    expect(row.dueAt).toEqual(plusSec(CREATED_AT, 60));
  });

  it('US-002 AC18: unconfigured email still inserts notifications (inside the transaction) and never schedules', async () => {
    const { writer, repo, schedule, email, txManager } = setup();
    email.configured = false;
    await writer.deliver([draft('a', { category: 'ASSIGNED' })]);
    expect(repo.insertMany).toHaveBeenCalledTimes(1);
    expect(txManager.run).toHaveBeenCalled();
    expect(schedule.scheduleNotifications).not.toHaveBeenCalled();
  });

  it('US-002 AC19: a user excluded by emailAllowedUserIds is left out of the scheduled rows', async () => {
    const { writer, preferences, schedule } = setup();
    preferences.emailAllowedUserIds.mockResolvedValue(new Set(['v']));
    await writer.deliver([draft('u', { category: 'ASSIGNED' }), draft('v', { category: 'ASSIGNED', sourceId: 'e2' })]);
    expect(schedule.scheduleNotifications).toHaveBeenCalled();
    const scheduled = schedule.scheduleNotifications.mock.calls[0][0] as Array<{ userId: string }>;
    expect(scheduled.some((r: { userId: string }) => r.userId === 'u')).toBe(false);
    expect(scheduled.filter((r: { userId: string }) => r.userId === 'v')).toHaveLength(1);
  });

  it('US-002 AC20: a schedule failure rolls back the inserted rows and the retry redoes insert + schedule', async () => {
    const { writer, repo, schedule, txManager } = setup();
    const committed: unknown[] = [];
    txManager.run.mockImplementation(async (fn: () => Promise<unknown>) => {
      const before = committed.length;
      try { return await fn(); } catch (error) { committed.splice(before); throw error; }
    });
    repo.insertMany.mockImplementation(async (d: readonly NotificationDraft[]) => {
      const rows = d.map((x, i) => ({ id: `n${i}`, userId: x.userId, category: x.category, kind: x.kind, createdAt: CREATED_AT }));
      committed.push(...rows);
      return rows;
    });
    schedule.scheduleNotifications
      .mockRejectedValueOnce(new Error('schedule unavailable'))
      .mockResolvedValueOnce(1);
    await expect(writer.deliver([draft('a', { category: 'ASSIGNED' })])).rejects.toThrow('schedule unavailable');
    expect(committed).toHaveLength(0);
    await writer.deliver([draft('a', { category: 'ASSIGNED' })]);
    expect(repo.insertMany).toHaveBeenCalledTimes(2);
    expect(schedule.scheduleNotifications).toHaveBeenCalledTimes(2);
    expect(committed).toHaveLength(1);
  });

  it('US-002: insert and schedule both run inside the transaction, publishes only after it commits', async () => {
    const { writer, order } = setup();
    await writer.deliver([draft('a', { category: 'ASSIGNED' })]);
    const txStart = order.indexOf('tx-start');
    const txEnd = order.indexOf('tx-end');
    expect(txStart).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('insert')).toBeGreaterThan(txStart);
    expect(order.indexOf('schedule')).toBeGreaterThan(order.indexOf('insert'));
    expect(order.indexOf('schedule')).toBeLessThan(txEnd);
    expect(order.indexOf('publish')).toBeGreaterThan(txEnd);
  });
});

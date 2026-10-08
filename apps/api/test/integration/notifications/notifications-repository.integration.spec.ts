/**
 * Fleet S4a §1: Notification unique key, read-all cutoff and purge, and watcher semantics on Postgres.
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/notifications/notifications-repository.integration.spec.ts
 */
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { NotificationsRepository } from '../../../src/notifications/notifications.repository';
import { TicketWatchersRepository } from '../../../src/notifications/ticket-watchers.repository';
import type { NotificationDraft } from '../../../src/notifications/notification.types';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('notifications repositories (PG)', () => {
  const prisma = new PrismaClient();
  const notifications = new NotificationsRepository({ client: prisma } as never);
  const watchers = new TicketWatchersRepository({ client: prisma } as never);
  const ids = { u1: '', u2: '', project: '', ticket: '' };

  const draft = (over: Partial<NotificationDraft> = {}): NotificationDraft => ({
    userId: ids.u1, projectId: ids.project, category: 'ASSIGNED', kind: 'ticket_assigned', title: 'A', body: null,
    link: '/p/tickets/PP-1', params: { ref: 'PP-1' }, sourceType: 'ticket_event', sourceId: 'evt-1', actorId: ids.u2, ...over,
  });

  beforeAll(async () => {
    await resetDb();
    ids.u1 = (await prisma.user.create({ data: { email: 'u1@k.t', passwordHash: 'x' } })).id;
    ids.u2 = (await prisma.user.create({ data: { email: 'u2@k.t', passwordHash: 'x' } })).id;
    ids.project = (await prisma.project.create({ data: { name: 'P', slug: 'p', key: 'PP' } })).id;
    ids.ticket = (await prisma.ticket.create({ data: { projectId: ids.project, number: 1, type: 'TASK', title: 't' } })).id;
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('a repeated draft inserts nothing (outbox redelivery, D501)', async () => {
    expect(await notifications.insertMany([draft()])).toHaveLength(1);
    expect(await notifications.insertMany([draft(), draft({ userId: ids.u2 })])).toEqual([{ id: expect.any(String), userId: ids.u2 }]);
    expect(await prisma.notification.count({ where: { sourceId: 'evt-1' } })).toBe(2);
  });

  it('read-all marks only rows created at or before the cutoff (Review Focus 5)', async () => {
    const cutoff = new Date();
    await prisma.notification.create({
      data: { userId: ids.u1, category: 'ASSIGNED', kind: 'ticket_assigned', title: 'late', link: '/x', sourceType: 'ticket_event', sourceId: 'evt-late', createdAt: new Date(cutoff.getTime() + 1000) },
    });
    await notifications.markAllRead(ids.u1, cutoff);
    const unread = await prisma.notification.findMany({ where: { userId: ids.u1, readAt: null }, select: { sourceId: true } });
    expect(unread).toEqual([{ sourceId: 'evt-late' }]);
    expect(await notifications.unreadCount(ids.u1)).toBe(1);
  });

  it('markRead refuses another user\'s row and is idempotent for the owner', async () => {
    const [row] = await notifications.insertMany([draft({ sourceId: 'evt-own' })]);
    const now = new Date();
    expect(await notifications.markRead(ids.u2, row.id, now)).toBe(false);
    expect(await notifications.markRead(ids.u1, row.id, now)).toBe(true);
    expect(await notifications.markRead(ids.u1, row.id, now)).toBe(true);
  });

  it('purgeRead keeps unread rows however old', async () => {
    const old = new Date('2020-01-01T00:00:00Z');
    await prisma.notification.create({
      data: { userId: ids.u2, category: 'ASSIGNED', kind: 'k', title: 'old read', link: '/x', sourceType: 'ticket_event', sourceId: 'old-read', createdAt: old, readAt: old },
    });
    await prisma.notification.create({
      data: { userId: ids.u2, category: 'ASSIGNED', kind: 'k', title: 'old unread', link: '/x', sourceType: 'ticket_event', sourceId: 'old-unread', createdAt: old },
    });
    expect(await notifications.purgeRead(new Date('2021-01-01T00:00:00Z'))).toBe(1);
    expect(await prisma.notification.count({ where: { sourceId: 'old-unread' } })).toBe(1);
  });

  it('auto-watch never un-mutes; watch/unwatch toggle the sticky mute (D502)', async () => {
    await watchers.ensure(ids.ticket, [{ userId: ids.u1, reason: 'REPORTER' }]);
    await watchers.unwatch(ids.ticket, ids.u1);
    await watchers.ensure(ids.ticket, [{ userId: ids.u1, reason: 'COMMENTER' }]);
    expect(await watchers.state(ids.ticket, ids.u1)).toEqual({ watching: false, count: 0 });
    expect(await watchers.findUnmutedUserIds(ids.ticket)).toEqual([]);
    await watchers.watch(ids.ticket, ids.u1);
    expect(await watchers.state(ids.ticket, ids.u1)).toEqual({ watching: true, count: 1 });
    const row = await prisma.ticketWatcher.findUniqueOrThrow({ where: { ticketId_userId: { ticketId: ids.ticket, userId: ids.u1 } } });
    expect(row.reason).toBe('REPORTER');
  });
});

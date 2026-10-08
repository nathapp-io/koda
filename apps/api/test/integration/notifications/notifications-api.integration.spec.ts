/**
 * Fleet S4a — notifications over real HTTP + outbox relay on Postgres (spec success criteria 1, 2, 7, 8).
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/notifications/notifications-api.integration.spec.ts
 */
import type { AddressInfo } from 'net';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { OutboxRelay } from '@nathapp/nestjs-outbox';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { TicketNotificationSubscriber } from '../../../src/notifications/ticket-notification.subscriber';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { openSse, SseConnection } from '../../helpers/sse-client';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

interface Note { id: string; kind: string; category: string; link: string; title: string; readAt: string | null }
interface NotePage { total: number; records: Note[] }

describeIntegration('notifications API (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let baseUrl: string;
  let relay: OutboxRelay;
  let prisma: PrismaClient;
  let streams: SseConnection[] = [];
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

  /** The relay takes 20 rows per batch; drain until a batch publishes nothing. */
  const drain = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) {
      const pending = await prisma.outboxEvent.count({ where: { status: 'pending' } });
      if (pending === 0) return;
      await relay.dispatchPendingBatch();
    }
  };
  const inbox = async (who: string, query = ''): Promise<NotePage> =>
    data<NotePage>(await request(server).get(`/api/me/notifications${query}`).set(auth(who)).expect(200));
  const kinds = async (who: string): Promise<string[]> => (await inbox(who, '?size=100')).records.map((n) => `${n.kind} ${n.link}`);

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    await app.listen(0, '127.0.0.1');
    server = app.getHttpServer();
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    relay = app.get(OutboxRelay);
    prisma = app.get(PrismaService).client as PrismaClient;

    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;
    ids.root = (await prisma.user.findUniqueOrThrow({ where: { email: 'root@koda.test' } })).id;
    await request(server).post('/api/projects').set(auth('root')).send({ name: 'Notif', slug: 'notif', key: 'NTF' }).expect(201);

    for (const who of ['dev', 'watcher', 'outsider']) {
      const res = await request(server).post('/api/admin/users').set(auth('root'))
        .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
      ids[who] = data<{ id: string }>(res).id;
      tokens[who] = await loginToken(server, `${who}@koda.test`);
    }
    for (const who of ['dev', 'watcher']) {
      await request(server).post('/api/projects/notif/members').set(auth('root'))
        .send({ email: `${who}@koda.test`, role: 'DEVELOPER' }).expect(201);
    }
    const agent = await request(server).post('/api/agents').set(auth('root'))
      .send({ name: 'Notif Bot', slug: 'notif-bot', roles: ['DEVELOPER'] }).expect(201);
    tokens.agent = data<{ apiKey: string }>(agent).apiKey;

    await request(server).post('/api/projects/notif/tickets').set(auth('root')).send({ type: 'BUG', title: 'First' }).expect(201);
    await drain();
  });

  afterEach(() => {
    streams.forEach((s) => s.close());
    streams = [];
  });

  afterAll(async () => {
    await app?.close();
  });

  it('assignment notifies the assignee live, never the actor (criterion 1)', async () => {
    const stream = await openSse(`${baseUrl}/api/me/events`, tokens.dev);
    streams = [...streams, stream];
    expect(stream.status).toBe(200);
    await stream.next((m) => m.event === 'ready');

    await request(server).post('/api/projects/notif/tickets/NTF-1/assign').set(auth('root')).send({ userId: ids.dev }).expect(200);
    await drain();

    const frame = await stream.next((m) => m.event === 'notification');
    const page = await inbox('dev');
    expect(page.records).toEqual([expect.objectContaining({
      kind: 'ticket_assigned', category: 'ASSIGNED', link: '/notif/tickets/NTF-1', title: 'Root assigned you NTF-1: First', readAt: null,
    })]);
    expect(JSON.parse(frame.data)).toEqual(expect.objectContaining({ type: 'notification', id: page.records[0].id }));
    expect(data<{ count: number }>(await request(server).get('/api/me/notifications/unread-count').set(auth('dev')).expect(200)).count).toBe(1);
    expect((await inbox('root')).total).toBe(0);
  });

  it('a comment notifies every unmuted watcher except the commenter (criterion 2)', async () => {
    await request(server).post('/api/projects/notif/tickets/NTF-1/comments').set(auth('watcher'))
      .send({ body: 'I can reproduce this', type: 'GENERAL' }).expect(201);
    await drain();
    expect(await kinds('dev')).toContain('ticket_commented /notif/tickets/NTF-1');
    expect(await kinds('root')).toContain('ticket_commented /notif/tickets/NTF-1');
    expect(await kinds('watcher')).not.toContain('ticket_commented /notif/tickets/NTF-1');
    const watchers = await prisma.ticketWatcher.findMany({ select: { userId: true, reason: true }, orderBy: { userId: 'asc' } });
    expect(watchers).toEqual(expect.arrayContaining([
      { userId: ids.root, reason: 'REPORTER' }, { userId: ids.dev, reason: 'ASSIGNEE' }, { userId: ids.watcher, reason: 'COMMENTER' },
    ]));
  });

  it('replaying the same ticket_event inserts nothing (D501)', async () => {
    const before = await prisma.notification.count();
    const last = await prisma.outboxEvent.findFirstOrThrow({ where: { type: 'ticket_event' }, orderBy: { createdAt: 'desc' } });
    const subscriber = app.get(TicketNotificationSubscriber);
    await subscriber.handle(JSON.parse(last.payload));
    await subscriber.handle(JSON.parse(last.payload));
    expect(await prisma.notification.count()).toBe(before);
  });

  it('a category switched off stops new notifications of that category only (criterion 7)', async () => {
    await request(server).put('/api/me/notification-preferences').set(auth('dev'))
      .send({ items: [{ category: 'WATCHED_ACTIVITY', inApp: false }] }).expect(200);
    const devBefore = (await inbox('dev')).total;
    await request(server).post('/api/projects/notif/tickets/NTF-1/verify').set(auth('root')).send({ body: 'verified' }).expect(200);
    await drain();
    expect((await inbox('dev')).total).toBe(devBefore);
    expect(await kinds('watcher')).toContain('ticket_status_changed /notif/tickets/NTF-1');
    const prefs = data<{ items: Array<{ category: string; inApp: boolean }> }>(
      await request(server).get('/api/me/notification-preferences').set(auth('dev')).expect(200));
    expect(prefs.items).toContainEqual({ category: 'WATCHED_ACTIVITY', inApp: false });
    expect(prefs.items).toContainEqual({ category: 'ASSIGNED', inApp: true });
  });

  it('unwatch mutes activity but an assignment still notifies (D502)', async () => {
    const off = data<{ watching: boolean; count: number }>(
      await request(server).delete('/api/projects/notif/tickets/NTF-1/watch').set(auth('watcher')).expect(200));
    expect(off.watching).toBe(false);
    const before = (await inbox('watcher')).total;
    await request(server).post('/api/projects/notif/tickets/NTF-1/comments').set(auth('root'))
      .send({ body: 'any update?', type: 'GENERAL' }).expect(201);
    await drain();
    expect((await inbox('watcher')).total).toBe(before);

    await request(server).post('/api/projects/notif/tickets/NTF-1/assign').set(auth('root')).send({ userId: ids.watcher }).expect(200);
    await drain();
    expect((await inbox('watcher')).records[0]).toEqual(expect.objectContaining({ kind: 'ticket_assigned' }));
    const state = data<{ watching: boolean }>(await request(server).get('/api/projects/notif/tickets/NTF-1/watchers').set(auth('watcher')).expect(200));
    expect(state.watching).toBe(false);
    const on = data<{ watching: boolean }>(await request(server).put('/api/projects/notif/tickets/NTF-1/watch').set(auth('watcher')).expect(200));
    expect(on.watching).toBe(true);
  });

  it('isolation: nobody reads or marks another user\'s inbox; agents and outsiders are refused (criterion 8)', async () => {
    const rootNote = (await inbox('root')).records[0];
    expect(rootNote).toBeDefined();
    await request(server).post(`/api/me/notifications/${rootNote.id}/read`).set(auth('dev')).expect(404);
    expect((await inbox('dev')).records.map((n) => n.id)).not.toContain(rootNote.id);
    expect((await inbox('root')).records[0].readAt).toBeNull();

    await request(server).get('/api/me/notifications').set(auth('agent')).expect(403);
    await request(server).get('/api/me/notifications/unread-count').set(auth('agent')).expect(403);
    await request(server).put('/api/me/notification-preferences').set(auth('agent')).send({ items: [{ category: 'ASSIGNED', inApp: false }] }).expect(403);
    await request(server).put('/api/projects/notif/tickets/NTF-1/watch').set(auth('outsider')).expect(403);
    await request(server).put('/api/projects/notif/tickets/NTF-999/watch').set(auth('dev')).expect(404);
    await request(server).put('/api/me/notification-preferences').set(auth('dev')).send({ items: [{ category: 'NOPE', inApp: false }] }).expect(400);
  });

  it('a ticket deleted before the relay runs produces no notification (Review Focus 1)', async () => {
    await request(server).post('/api/projects/notif/tickets').set(auth('root')).send({ type: 'TASK', title: 'Doomed' }).expect(201);
    await request(server).post('/api/projects/notif/tickets/NTF-2/comments').set(auth('dev')).send({ body: 'hm', type: 'GENERAL' }).expect(201);
    await request(server).delete('/api/projects/notif/tickets/NTF-2').set(auth('root')).expect(200);
    await drain();
    expect(await prisma.notification.count({ where: { link: '/notif/tickets/NTF-2' } })).toBe(0);
    expect(await prisma.outboxEvent.count({ where: { status: 'dead' } })).toBe(0);
  });

  it('mark one read, then read-all, leaves nothing unread', async () => {
    const [first] = (await inbox('watcher')).records;
    await request(server).post(`/api/me/notifications/${first.id}/read`).set(auth('watcher')).expect(204);
    await request(server).post(`/api/me/notifications/${first.id}/read`).set(auth('watcher')).expect(204);
    await request(server).post('/api/me/notifications/read-all').set(auth('watcher')).expect(204);
    expect(data<{ count: number }>(await request(server).get('/api/me/notifications/unread-count').set(auth('watcher')).expect(200)).count).toBe(0);
    expect((await inbox('watcher', '?unread=true')).total).toBe(0);
  });
});

/**
 * S4a slice 3 — @mentions end to end on Postgres: token -> outbox -> MENTIONED notification + MENTIONED watcher.
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/notifications/mentions
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { OutboxRelay } from '@nathapp/nestjs-outbox';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const mention = (label: string, userId: string): string => `@[${label}](user:${userId})`;

describeIntegration('@mention notifications (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let relay: OutboxRelay;
  let prisma: PrismaClient;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const drain = async (): Promise<void> => { await relay.dispatchPendingBatch(); await relay.dispatchPendingBatch(); };
  const mentionsFor = (who: string, ticketId: string) =>
    prisma.notification.findMany({ where: { userId: ids[who], kind: 'ticket_mentioned', sourceType: 'ticket_event' } })
      .then((rows) => rows.filter((r) => (r.link as string).endsWith(`/tickets/${ticketId}`)));

  let seq = 0;
  async function newTicket(description?: string): Promise<{ ref: string; id: string }> {
    seq += 1;
    const res = await request(server).post('/api/projects/men/tickets').set(auth('author'))
      .send({ type: 'BUG', title: `Mention ${seq}`, ...(description ? { description } : {}) }).expect(201);
    const body = data<{ id: string; ref?: string; number?: number }>(res);
    return { id: body.id, ref: body.ref ?? `MEN-${body.number}` };
  }

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    relay = app.get(OutboxRelay);
    prisma = app.get(PrismaService).client as PrismaClient;

    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;
    await request(server).post('/api/projects').set(auth('root')).send({ name: 'Mentions', slug: 'men', key: 'MEN' }).expect(201);

    for (const who of ['author', 'member', 'muted', 'outsider']) {
      const res = await request(server).post('/api/admin/users').set(auth('root'))
        .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
      ids[who] = data<{ id: string }>(res).id;
      tokens[who] = await loginToken(server, `${who}@koda.test`);
    }
    for (const who of ['author', 'member', 'muted']) {
      await request(server).post('/api/projects/men/members').set(auth('root'))
        .send({ email: `${who}@koda.test`, role: 'DEVELOPER' }).expect(201);
    }
    await drain();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('a comment mention notifies the member once, makes them a MENTIONED watcher, and ignores a non-member', async () => {
    const ticket = await newTicket();
    await request(server).post(`/api/projects/men/tickets/${ticket.ref}/comments`).set(auth('author'))
      .send({ type: 'GENERAL', body: `cc ${mention('Member', ids.member)} and ${mention('Out', ids.outsider)}` }).expect(201);
    await drain();
    await drain(); // a redelivery must not duplicate

    const rows = await mentionsFor('member', ticket.ref);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ category: 'MENTIONED', actorId: ids.author }));
    const watcher = await prisma.ticketWatcher.findUnique({ where: { ticketId_userId: { ticketId: ticket.id, userId: ids.member } } });
    expect(watcher).toEqual(expect.objectContaining({ reason: 'MENTIONED', muted: false }));

    expect(await prisma.notification.count({ where: { userId: ids.outsider } })).toBe(0);
    expect(await prisma.ticketWatcher.count({ where: { ticketId: ticket.id, userId: ids.outsider } })).toBe(0);
  });

  it('a mentioned watcher gets MENTIONED only, not also WATCHED_ACTIVITY, for the same comment', async () => {
    const ticket = await newTicket();
    await request(server).post(`/api/projects/men/tickets/${ticket.ref}/comments`).set(auth('member'))
      .send({ type: 'GENERAL', body: 'I am watching now' }).expect(201);
    await drain();
    await request(server).post(`/api/projects/men/tickets/${ticket.ref}/comments`).set(auth('author'))
      .send({ type: 'GENERAL', body: `ping ${mention('Member', ids.member)}` }).expect(201);
    await drain();

    const event = await prisma.ticketEvent.findFirst({ where: { ticketId: ticket.id, action: 'COMMENT_ADDED', actorId: ids.author } });
    const forEvent = await prisma.notification.findMany({ where: { userId: ids.member, sourceId: event?.id } });
    expect(forEvent.map((r) => r.category)).toEqual(['MENTIONED']);
  });

  it('a muted watcher still receives a direct mention (D502)', async () => {
    const ticket = await newTicket();
    await request(server).post(`/api/projects/men/tickets/${ticket.ref}/comments`).set(auth('muted'))
      .send({ type: 'GENERAL', body: 'joining' }).expect(201);
    await drain();
    await request(server).delete(`/api/projects/men/tickets/${ticket.ref}/watch`).set(auth('muted')).expect(200);
    await request(server).post(`/api/projects/men/tickets/${ticket.ref}/comments`).set(auth('author'))
      .send({ type: 'GENERAL', body: `need you ${mention('Muted', ids.muted)}` }).expect(201);
    await drain();

    expect(await mentionsFor('muted', ticket.ref)).toHaveLength(1);
    const watcher = await prisma.ticketWatcher.findUnique({ where: { ticketId_userId: { ticketId: ticket.id, userId: ids.muted } } });
    expect(watcher?.muted).toBe(true); // auto-watch never un-mutes
  });

  it('a description mention on create notifies; editing adds only newly mentioned users', async () => {
    const ticket = await newTicket(`spec by ${mention('Member', ids.member)}`);
    await drain();
    expect(await mentionsFor('member', ticket.ref)).toHaveLength(1);

    await request(server).patch(`/api/projects/men/tickets/${ticket.ref}`).set(auth('author'))
      .send({ description: `spec by ${mention('Member', ids.member)}, reviewed by ${mention('Muted', ids.muted)}` }).expect(200);
    await drain();
    expect(await mentionsFor('member', ticket.ref)).toHaveLength(1);
    expect(await mentionsFor('muted', ticket.ref)).toHaveLength(1);

    await request(server).patch(`/api/projects/men/tickets/${ticket.ref}`).set(auth('author'))
      .send({ description: `spec by ${mention('Member', ids.member)}, reviewed by ${mention('Muted', ids.muted)}.` }).expect(200);
    await drain();
    expect(await mentionsFor('member', ticket.ref)).toHaveLength(1);
    expect(await mentionsFor('muted', ticket.ref)).toHaveLength(1);
  });

  it('mentioning yourself creates nothing', async () => {
    const ticket = await newTicket();
    await request(server).post(`/api/projects/men/tickets/${ticket.ref}/comments`).set(auth('author'))
      .send({ type: 'GENERAL', body: `note to ${mention('Me', ids.author)}` }).expect(201);
    await drain();
    expect(await mentionsFor('author', ticket.ref)).toHaveLength(0);
  });
});

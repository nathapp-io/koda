/**
 * Slice 5 — comment create records COMMENT_ADDED (TicketEvent + outbox row) atomically, on real Postgres.
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/comments/comment-event
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, TEST_PASSWORD } from '../../helpers/http-app';
import { TicketEventService } from '../../../src/events/ticket-event.service';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('comment create → COMMENT_ADDED (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let token: string;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get(PrismaService).client as PrismaClient;
    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    token = data<{ accessToken: string }>(root).accessToken;
    await request(server).post('/api/projects').set({ Authorization: `Bearer ${token}` })
      .send({ name: 'Comments', slug: 'comments', key: 'CMT' }).expect(201);
    await request(server).post('/api/projects/comments/tickets').set({ Authorization: `Bearer ${token}` })
      .send({ type: 'BUG', title: 'Commented ticket' }).expect(201);
  });

  afterAll(async () => {
    await app.close();
  });

  it('writes the comment, a COMMENT_ADDED TicketEvent and a ticket_event outbox row', async () => {
    const res = await request(server).post('/api/projects/comments/tickets/CMT-1/comments')
      .set({ Authorization: `Bearer ${token}` })
      .send({ body: 'first comment', type: 'GENERAL' }).expect(201);
    const commentId = data<{ id: string }>(res).id;

    const events = await prisma.ticketEvent.findMany({ where: { action: 'COMMENT_ADDED' } });
    expect(events).toHaveLength(1);
    expect(JSON.parse(String(events[0].data))).toEqual({ commentId });

    const outbox = await prisma.outboxEvent.findMany({ where: { type: 'ticket_event', eventId: events[0].id } });
    expect(outbox).toHaveLength(1);
    const payload = JSON.parse(String(outbox[0].payload)) as Record<string, unknown>;
    expect(payload).toEqual(expect.objectContaining({ id: events[0].id, action: 'COMMENT_ADDED' }));
    expect(outbox[0].payload).not.toContain('first comment');
  });

  it('a comment created by a transition emits only status_changed', async () => {
    const before = await prisma.ticketEvent.count({ where: { action: 'COMMENT_ADDED' } });

    await request(server).post('/api/projects/comments/tickets/CMT-1/verify')
      .set({ Authorization: `Bearer ${token}` })
      .send({ body: 'verified with a comment' }).expect(200);

    expect(await prisma.ticketEvent.count({ where: { action: 'COMMENT_ADDED' } })).toBe(before);
    expect(await prisma.ticketEvent.count({ where: { action: 'status_changed' } })).toBe(1);
  });

  it('rolls the comment back when the event write fails', async () => {
    const before = await prisma.comment.count();
    const events = app.get(TicketEventService);
    const spy = vi.spyOn(events, 'create').mockRejectedValueOnce(new Error('event write failed'));

    try {
      await request(server).post('/api/projects/comments/tickets/CMT-1/comments')
        .set({ Authorization: `Bearer ${token}` })
        .send({ body: 'rolled back', type: 'GENERAL' });
    } finally {
      spy.mockRestore();
    }

    expect(await prisma.comment.count()).toBe(before);
    expect(await prisma.comment.findFirst({ where: { body: 'rolled back' } })).toBeNull();
  });
});

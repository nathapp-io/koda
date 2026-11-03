import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { CommentsService } from '../../../src/comments/comments.service';
import { PrismaTicketsRepository } from '../../../src/tickets/prisma-tickets.repository';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('comment soft delete', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let project: { id: string; slug: string };
  let ticket: { id: string; ref: string };
  let counter = 0;
  const server = () => app.getHttpServer();
  const rootAuth = () => ({ Authorization: `Bearer ${world.tokens.root}` });
  const commentsPath = () => `/api/projects/${project.slug}/tickets/${ticket.ref}/comments`;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null, swagger: true });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    project = data(await request(server()).post('/api/projects').set(rootAuth()).send({
      name: 'Comment soft deletes', slug: 'comment-soft-deletes', key: 'CSD',
    }).expect(201));
  }, 60000);

  beforeEach(async () => {
    resetThrottle(app);
    ticket = data(await request(server()).post(`/api/projects/${project.slug}/tickets`).set(rootAuth()).send({
      type: 'BUG', title: `comment target ${++counter}`,
    }).expect(201));
  });

  afterAll(async () => { await app?.close(); });

  it('AC-3/4/5: DELETE retains the row but removes it from the ticket comment list and active count', async () => {
    const createResponse = await request(server()).post(commentsPath()).set(rootAuth()).send({ body: 'retain this row' });
    expect(createResponse.status, JSON.stringify(createResponse.body)).toBe(201);
    const created = data<{ id: string }>(createResponse);
    const activeBefore = await db.comment.count({ where: { ticketId: ticket.id, deletedAt: null } });
    expect(activeBefore).toBe(1);

    await request(server()).delete(`/api/comments/${created.id}`).set(rootAuth()).expect(204);

    const retained = await db.comment.findUniqueOrThrow({ where: { id: created.id } });
    expect(retained.deletedAt).toBeInstanceOf(Date);
    const listed = data<Array<{ id: string }>>(await request(server()).get(commentsPath()).set(rootAuth()).expect(200));
    expect(listed.some((comment) => comment.id === created.id)).toBe(false);
    expect(await db.comment.count({ where: { ticketId: ticket.id, deletedAt: null } })).toBe(activeBefore - 1);
    const excerpt = await app.get(CommentsService).findRecentByTicket(project.slug, ticket.ref, 10);
    expect(excerpt.total).toBe(activeBefore - 1);
  });

  it('AC-8: ticket-comment aggregation excludes deleted rows in PostgreSQL', async () => {
    const live = await db.comment.create({ data: { ticketId: ticket.id, body: 'live', type: 'GENERAL' } });
    const tombstone = await db.comment.create({ data: { ticketId: ticket.id, body: 'deleted', type: 'GENERAL', deletedAt: new Date() } });

    const result = await app.get(PrismaTicketsRepository).findTicketWithComments(ticket.id);

    expect(result?.comments.map(({ body }) => body)).toContain('live');
    expect(result?.comments.map(({ body }) => body)).not.toContain('deleted');
    expect(result?.comments.map(({ body }) => body)).not.toContain(tombstone.body);
    expect(await db.comment.findUniqueOrThrow({ where: { id: live.id } })).toBeDefined();
  });

  it('AC-6/7: PATCH and repeated DELETE of a deleted comment both answer 404', async () => {
    const createResponse = await request(server()).post(commentsPath()).set(rootAuth()).send({ body: 'gone from reads' });
    expect(createResponse.status, JSON.stringify(createResponse.body)).toBe(201);
    const created = data<{ id: string }>(createResponse);
    await request(server()).delete(`/api/comments/${created.id}`).set(rootAuth()).expect(204);

    await request(server()).patch(`/api/comments/${created.id}`).set(rootAuth()).send({ body: 'edit' }).expect(404);
    await request(server()).delete(`/api/comments/${created.id}`).set(rootAuth()).expect(404);
    expect(await db.comment.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ body: 'gone from reads' });
  });
});

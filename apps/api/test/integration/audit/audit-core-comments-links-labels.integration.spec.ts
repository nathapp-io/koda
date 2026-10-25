import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
const slug = 'audit-comments-links-labels';
const describeTimeout = 30_000;

describeIntegration('US-004 audited comments, links and ticket labels', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let projectId: string;
  let rootToken: string;
  let memberToken: string;
  let ref: string;

  const rootAuth = () => ({ Authorization: `Bearer ${rootToken}` });
  const createComment = async (body = 'comment') => {
    const response = await request(server).post(`/api/projects/${slug}/tickets/${ref}/comments`).set(rootAuth()).send({ body }).expect(201);
    return data<{ id: string }>(response);
  };
  const rows = (key: string, resourceId: string) => db.auditEntry.findMany({ where: { key, resourceId } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    server = app.getHttpServer();
    db = fixtureDb(app);
    const registered = await request(server).post('/api/auth/register').send({
      email: 'audit-us004-root@koda.test', name: 'Audit root', password: TEST_PASSWORD,
    }).expect(201);
    rootToken = data<{ accessToken: string }>(registered).accessToken;
    const project = await request(server).post('/api/projects').set(rootAuth()).send({ name: 'Audit', slug, key: 'AUD' }).expect(201);
    projectId = data<{ id: string }>(project).id;
    const ticket = await request(server).post(`/api/projects/${slug}/tickets`).set(rootAuth()).send({ type: 'BUG', title: 'fixture' }).expect(201);
    ref = data<{ ref: string }>(ticket).ref;
    const member = await request(server).post('/api/admin/users').set(rootAuth()).send({
      email: 'audit-us004-member@koda.test', name: 'Member', password: TEST_PASSWORD, role: 'MEMBER',
    }).expect(201);
    const memberId = data<{ id: string }>(member).id;
    await grantRole(db, { type: 'USER', id: memberId }, 'viewer', projectId);
    memberToken = await loginToken(server, 'audit-us004-member@koda.test');
  }, 60_000);

  afterAll(async () => { await app?.close(); });

  it('AC-1..3: comment create records one safe audit entry with project and ref', async () => {
    const response = await request(server).post(`/api/projects/${slug}/tickets/${ref}/comments`).set(rootAuth()).send({ body: 'hello secret' }).expect(201);
    const comment = data<{ id: string }>(response);
    const entries = await rows('comment.create', comment.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ resourceType: 'comment', projectId, summary: `on ${ref}` });
    expect(entries[0].summary).not.toContain('hello secret');
  }, describeTimeout);

  it('AC-4,5,6: author update is audited, and refused member update creates no entry', async () => {
    const comment = await createComment();
    await request(server).patch(`/api/comments/${comment.id}`).set(rootAuth()).send({ body: 'changed' }).expect(200);
    expect(await rows('comment.update', comment.id)).toHaveLength(1);
    expect((await rows('comment.update', comment.id))[0].summary).toBe('edited');

    const refusedComment = await createComment('other author');
    await request(server).patch(`/api/comments/${refusedComment.id}`).set({ Authorization: `Bearer ${memberToken}` }).send({ body: 'nope' }).expect(403);
    expect(await rows('comment.update', refusedComment.id)).toHaveLength(0);
  }, describeTimeout);

  it('AC-7: author delete records the comment delete action', async () => {
    const comment = await createComment();
    await request(server).delete(`/api/comments/${comment.id}`).set(rootAuth()).expect(204);
    const entries = await rows('comment.delete', comment.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].summary).toBe('deleted');
  }, describeTimeout);

  it('AC-10..14,17: link writes audit once, idempotency is quiet, removal and CUID refs are canonical', async () => {
    const url = 'https://example.com/audit-us004';
    const created = await request(server).post(`/api/projects/${slug}/tickets/${ref}/links`).set(rootAuth()).send({ url }).expect(201);
    const link = data<{ id: string }>(created);
    const createdRows = await rows('ticket.link.add', link.id);
    expect(createdRows).toHaveLength(1);
    expect(createdRows[0]).toMatchObject({ resourceType: 'ticket-link', projectId, summary: `on ${ref}` });
    await request(server).post(`/api/projects/${slug}/tickets/${ref}/links`).set(rootAuth()).send({ url }).expect(200);
    expect(await rows('ticket.link.add', link.id)).toHaveLength(1);
    await request(server).delete(`/api/projects/${slug}/tickets/${ref}/links/${link.id}`).set(rootAuth()).expect(204);
    expect(await rows('ticket.link.remove', link.id)).toHaveLength(1);
    expect((await rows('ticket.link.remove', link.id))[0].summary).toBe(`from ${ref}`);

    const ticketId = (await db.ticket.findFirstOrThrow({ where: { projectId }, select: { id: true } })).id;
    const cuidUrl = 'https://example.com/audit-us004-cuid';
    const byCuid = await request(server).post(`/api/projects/${slug}/tickets/${ticketId}/links`).set(rootAuth()).send({ url: cuidUrl }).expect(201);
    const cuidLink = data<{ id: string }>(byCuid);
    expect((await rows('ticket.link.add', cuidLink.id))[0].summary).toBe(`on ${ref}`);
  }, describeTimeout);

  it('AC-15,16: ticket-label assign and remove use identifier-only summaries', async () => {
    const labelResponse = await request(server).post(`/api/projects/${slug}/labels`).set(rootAuth()).send({ name: 'secret label name' }).expect(201);
    const labelId = data<{ id: string }>(labelResponse).id;
    const ticketId = (await db.ticket.findFirstOrThrow({ where: { projectId }, select: { id: true } })).id;
    await request(server).post(`/api/projects/${slug}/tickets/${ref}/labels`).set(rootAuth()).send({ labelId }).expect(201);
    const assigned = await rows('ticket.label.assign', ticketId);
    expect(assigned).toHaveLength(1);
    expect(assigned[0].summary).toBe(`label ${labelId} added`);
    expect(assigned[0].summary).not.toContain('secret label name');
    await request(server).delete(`/api/projects/${slug}/tickets/${ref}/labels/${labelId}`).set(rootAuth()).expect(204);
    const removed = await rows('ticket.label.remove', ticketId);
    expect(removed).toHaveLength(1);
    expect(removed[0].summary).toBe(`label ${labelId} removed`);
  }, describeTimeout);
});

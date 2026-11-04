import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { bootHttpApp, data } from '../../helpers/http-app';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { seedFleetHttpAgent, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { PrismaFleetTicketsRepository } from '../../../src/fleet/tickets/prisma-fleet-tickets.repository';
import { TicketsService } from '../../../src/tickets/tickets.service';
import { VcsPrSyncService } from '../../../src/vcs/vcs-pr-sync.service';
import type { TicketLinkData } from '../../../src/vcs/domain/vcs.repository';

(canRunDbTests() ? describe : describe.skip)('ruling finish ticket atomicity (PG)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: Awaited<ReturnType<typeof seedFleetHttpWorld>>;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let seq = 500;
  const auth = () => ({ Authorization: `Bearer ${agent.apiKey}` });
  const post = (id: string) => request(app.getHttpServer()).post(`/api/projects/web/fleet/jobs/${id}/rulings`).set(auth()).send({ itemId: 'D-1', text: 'confirm: test green' });
  const job = () => db.fleetJob.create({ data: {
    projectId: world.projectId, repoId: world.repoId, command: 'RUN', feature: `finish-${++seq}`, ref: 'main', profiles: [], selectorLabels: [], maxCostUsd: '1', requestedById: agent.id,
    resultPrUrl: `https://github.com/acme/app/pull/${seq}`, workflow: { outcome: 'draft', openItems: [{ id: 'D-1', kind: 'advisor' }] },
  } });
  const linked = (id: string) => db.fleetJobTicket.findMany({ where: { jobId: id }, include: { ticket: true } });
  const createTicket = async (status: string, number: number) => db.ticket.create({ data: { projectId: world.projectId, number, type: 'TASK', title: 'Existing work', status } });
  beforeAll(async () => {
    await resetDb(); app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null }); db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db); agent = await seedFleetHttpAgent(app.getHttpServer(), world.tokens.root);
    // A custom role proves fleet.job.rule, without ticket.create or transition permissions, is sufficient.
    const role = await db.role.create({ data: { key: 'finish-ruler', name: 'finish-ruler', scope: 'PROJECT', permissions: ['project.read', 'fleet.job.rule', 'comment.update.own', 'comment.delete.own'] } });
    await grantRole(db, { type: 'AGENT', id: agent.id }, role.name, world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 60000);
  afterAll(async () => { await app?.close(); });
  afterEach(() => { vi.restoreAllMocks(); });
  it('AC-2/3/4/5: POST creates a started TASK, fleet PR link and authored RULING; next POST reuses it', async () => {
    const j = await job(); const ruling = data<{ commentId: string }>(await post(j.id).expect(201));
    const rows = await linked(j.id); expect(rows).toHaveLength(1); const ticket = rows[0].ticket;
    expect(ticket).toMatchObject({ type: 'TASK', title: `Finish draft PR #${seq} (${j.feature})`, status: 'IN_PROGRESS', createdByAgentId: agent.id });
    expect(await db.ticketLink.findMany({ where: { ticketId: ticket.id } })).toEqual([expect.objectContaining({ source: 'fleet', linkType: 'pr', prNumber: seq, url: j.resultPrUrl })]);
    expect(await db.comment.findUnique({ where: { id: ruling.commentId } })).toMatchObject({ ticketId: ticket.id, type: 'RULING', authorAgentId: agent.id, authorUserId: null, body: 'D-1 (advisor): confirm: test green' });
    await post(j.id).expect(201); expect(await linked(j.id)).toHaveLength(1);
    expect(await db.comment.count({ where: { ticketId: ticket.id, type: 'RULING' } })).toBe(2);
  });
  it('AC-6: uses oldest link, not lowest ticket number', async () => {
    const j = await job(); const newer = await createTicket('CREATED', ++seq); const oldest = await createTicket('IN_PROGRESS', ++seq);
    await db.fleetJobTicket.create({ data: { jobId: j.id, ticketId: oldest.id, createdAt: new Date(0) } });
    await db.fleetJobTicket.create({ data: { jobId: j.id, ticketId: newer.id, createdAt: new Date(1000) } });
    const ruling = data<{ commentId: string }>(await post(j.id).expect(201));
    expect(await db.comment.findUnique({ where: { id: ruling.commentId } })).toMatchObject({ ticketId: oldest.id });
    expect(await linked(j.id)).toHaveLength(2);
  });
  it.each(['CLOSED', 'REJECTED', 'deleted'])('AC-7: ignores ineligible linked ticket %s', async (status) => {
    const j = await job(); const ticket = await createTicket(status === 'deleted' ? 'CREATED' : status, ++seq);
    if (status === 'deleted') await db.ticket.update({ where: { id: ticket.id }, data: { deletedAt: new Date() } });
    await db.fleetJobTicket.create({ data: { jobId: j.id, ticketId: ticket.id } });
    const ruling = data<{ commentId: string }>(await post(j.id).expect(201));
    expect(await db.comment.findUnique({ where: { id: ruling.commentId } })).not.toMatchObject({ ticketId: ticket.id });
    expect(await linked(j.id)).toHaveLength(2);
  });
  it('AC-8: concurrent first rulings leave exactly one ticket and two comments', async () => {
    const j = await job(); await Promise.all([post(j.id).expect(201), post(j.id).expect(201)]);
    const rows = await linked(j.id); expect(rows).toHaveLength(1);
    expect(await db.comment.count({ where: { ticketId: rows[0].ticketId, type: 'RULING' } })).toBe(2);
  });
  it('AC-9: edit is immutable but delete is allowed and preserves commentId', async () => {
    const j = await job(); const ruling = data<{ id: string; commentId: string }>(await post(j.id).expect(201));
    const response = await request(app.getHttpServer()).patch(`/api/comments/${ruling.commentId}`).set(auth()).send({ body: 'changed' }).expect(409);
    expect(JSON.stringify(response.body)).toContain('Workflow comments cannot be edited');
    await request(app.getHttpServer()).delete(`/api/comments/${ruling.commentId}`).set({ Authorization: `Bearer ${world.tokens.root}` }).expect(204);
    expect(await db.comment.findUnique({ where: { id: ruling.commentId } })).toMatchObject({ deletedAt: expect.any(Date) });
    expect(await db.fleetPrRuling.findUnique({ where: { id: ruling.id } })).toMatchObject({ commentId: ruling.commentId });
  });
  it.each(['comment', 'ticket'])('AC-10/13: %s failure rolls back every write', async (failure) => {
    const j = await job(); const before = await db.ticket.count({ where: { projectId: world.projectId } });
    if (failure === 'comment') vi.spyOn(app.get(PrismaFleetTicketsRepository), 'createRulingComment').mockRejectedValue(new Error('comment unavailable'));
    else vi.spyOn(app.get(TicketsService), 'create').mockRejectedValue(new Error('ticket unavailable'));
    await post(j.id).expect(500);
    expect(await db.fleetPrRuling.count({ where: { jobId: j.id } })).toBe(0);
    expect(await linked(j.id)).toHaveLength(0); expect(await db.ticket.count({ where: { projectId: world.projectId } })).toBe(before);
  });
  it('AC-12: existing merged-PR sync moves the finish ticket to VERIFY_FIX', async () => {
    const j = await job(); await post(j.id).expect(201); const [row] = await linked(j.id);
    const link = await db.ticketLink.findFirstOrThrow({ where: { ticketId: row.ticketId }, include: { ticket: { select: { id: true, status: true, projectId: true, number: true, externalVcsId: true } } } });
    await withTestActor({ type: 'SYSTEM', id: 'vcs' }, () => app.get(VcsPrSyncService).applyMergedPr(link as TicketLinkData, { number: seq, state: 'closed', merged: true, mergedBy: 'dev', mergeSha: 'abc', url: link.url, title: 'Finish', draft: false, mergedAt: new Date(), branchName: 'feature' }));
    expect(await db.ticket.findUnique({ where: { id: row.ticketId } })).toMatchObject({ status: 'VERIFY_FIX' });
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { TicketLinksService } from '../../../src/ticket-links/ticket-links.service';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
const permissionsRefused = (JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en/permissions.json'), 'utf8')) as Record<string, string>)['40003'];
interface Pending { id: string; permissionKey: string }
interface Settled { status: string; result: unknown }

describeIntegration('gated ticket destructive routes', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let own: typeof agent;
  let keyless: typeof agent;
  let developer: typeof agent;
  let p: { id: string; slug: string };
  let counter = 0;
  const server = () => app.getHttpServer();
  const auth = (token = agent.apiKey) => ({ Authorization: `Bearer ${token}` });
  const root = () => auth(world.tokens.root);
  const base = () => `/api/projects/${p.slug}`;
  const pending = (res: request.Response) => { expect(res.status).toBe(202); return data<Pending>(res); };
  const approve = async (id: string) => data<Settled>(await request(server()).post(`/api/approvals/${id}/decisions`).set(root()).send({ decision: 'approve' }).expect(200));
  const ticket = async () => data<{ id: string; ref: string }>(await request(server()).post(`${base()}/tickets`).set(root()).send({ type: 'BUG', title: `gate ${++counter}` }).expect(201));
  const label = async () => data<{ id: string }>(await request(server()).post(`${base()}/labels`).set(root()).send({ name: `label ${++counter}` }).expect(201));
  const link = async (ref: string) => data<{ id: string }>(await request(server()).post(`${base()}/tickets/${ref}/links`).set(root()).send({ url: `https://github.com/acme/repo/pull/${++counter}` }).expect(201));

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    p = data(await request(server()).post('/api/projects').set(root()).send({ name: 'Ticket gates', slug: 'ticket-gates', key: 'TG' }).expect(201));
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    own = await seedFleetHttpAgent(server(), world.tokens.root);
    keyless = await seedFleetHttpAgent(server(), world.tokens.root);
    developer = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'ticket.delete', 'label.delete', 'ticket.label.remove', 'ticket.link.remove'], p.id);
    await grantKeys(db, { type: 'AGENT', id: own.id }, ['project.read', 'ticket.link.remove.own'], p.id);
    await grantKeys(db, { type: 'AGENT', id: keyless.id }, ['project.read'], p.id);
    await grantRole(db, { type: 'AGENT', id: developer.id }, 'developer', p.id);
    await grantKeys(db, { type: 'AGENT', id: developer.id }, ['project.read'], p.id);
    await app.get(PermissionCache).invalidate();
  }, 60000);
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await app?.close(); });

  it('AC-1/2: ticket stays while pending, then root approval soft-deletes and stores its ref', async () => {
    const row = await ticket();
    const summary = pending(await request(server()).delete(`${base()}/tickets/${row.ref}`).set(auth()));
    expect(summary.permissionKey).toBe('ticket.delete');
    expect((await db.ticket.findUniqueOrThrow({ where: { id: row.id } })).deletedAt).toBeNull();
    expect(await approve(summary.id)).toMatchObject({ status: 'executed', result: { ref: row.ref } });
    expect((await db.ticket.findUniqueOrThrow({ where: { id: row.id } })).deletedAt).not.toBeNull();
  });
  it('AC-3: label waits, then is removed by approval', async () => {
    const row = await label();
    const summary = pending(await request(server()).delete(`${base()}/labels/${row.id}`).set(auth()));
    expect(await db.label.findUnique({ where: { id: row.id } })).not.toBeNull();
    expect(await approve(summary.id)).toMatchObject({ status: 'executed', result: null });
    expect(await db.label.findUnique({ where: { id: row.id } })).toBeNull();
  });
  it('AC-4: ticket-label assignment waits, then is removed by approval', async () => {
    const t = await ticket();
    const l = await label();
    await request(server()).post(`${base()}/tickets/${t.ref}/labels`).set(root()).send({ labelId: l.id }).expect(201);
    const summary = pending(await request(server()).delete(`${base()}/tickets/${t.ref}/labels/${l.id}`).set(auth()));
    const where = { ticketId: t.id, labelId: l.id };
    expect(await db.ticketLabel.count({ where })).toBe(1);
    expect(await approve(summary.id)).toMatchObject({ status: 'executed', result: null });
    expect(await db.ticketLabel.count({ where })).toBe(0);
  });
  it('AC-5: link waits, then is removed by approval', async () => {
    const t = await ticket();
    const row = await link(t.ref);
    const summary = pending(await request(server()).delete(`${base()}/tickets/${t.ref}/links/${row.id}`).set(auth()));
    expect(await db.ticketLink.findUnique({ where: { id: row.id } })).not.toBeNull();
    expect(await approve(summary.id)).toMatchObject({ status: 'executed', result: null });
    expect(await db.ticketLink.findUnique({ where: { id: row.id } })).toBeNull();
  });
  it('AC-6: other-owner .own request fails only at approved execution and preserves the link', async () => {
    const t = await ticket();
    const row = await link(t.ref);
    const summary = pending(await request(server()).delete(`${base()}/tickets/${t.ref}/links/${row.id}`).set(auth(own.apiKey)));
    expect(await approve(summary.id)).toMatchObject({ status: 'failed', result: { error: 'execution-failed', name: new ForbiddenAppException({}, 'permissions').name } });
    expect(await db.ticketLink.findUnique({ where: { id: row.id } })).not.toBeNull();
  });
  it('AC-7: missing link fails only at approved execution', async () => {
    const t = await ticket();
    const summary = pending(await request(server()).delete(`${base()}/tickets/${t.ref}/links/missing`).set(auth()));
    expect(await approve(summary.id)).toMatchObject({ status: 'failed', result: { error: 'execution-failed', name: new NotFoundAppException({}, 'ticket-links').name } });
  });
  it('AC-8: root deletes label immediately with 204 and no request', async () => {
    const row = await label();
    await request(server()).delete(`${base()}/labels/${row.id}`).set(root()).expect(204);
    expect(await db.label.findUnique({ where: { id: row.id } })).toBeNull();
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('AC-9: Developer ticket-delete refusal opens no request', async () => {
    const t = await ticket();
    const res = await request(server()).delete(`${base()}/tickets/${t.ref}`).set(auth(developer.apiKey));
    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(permissionsRefused);
    expect(await db.approvalRequest.count()).toBe(0);
    expect((await db.ticket.findUniqueOrThrow({ where: { id: t.id } })).deletedAt).toBeNull();
  });
  it('AC-13 FM-1: keyless missing-link deletion is refused before service lookup and opens no request', async () => {
    const t = await ticket();
    const remove = vi.spyOn(app.get(TicketLinksService), 'remove');
    const res = await request(server()).delete(`${base()}/tickets/${t.ref}/links/missing`).set(auth(keyless.apiKey));
    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(permissionsRefused);
    expect(remove).not.toHaveBeenCalled();
    expect(await db.approvalRequest.count()).toBe(0);
  });
});

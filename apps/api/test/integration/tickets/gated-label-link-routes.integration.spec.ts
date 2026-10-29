import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
interface Pending { id: string; permissionKey: string }
interface Settled { status: string; result: unknown }

describeIntegration('gated label and link writes', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let p: { id: string; slug: string };
  let other: { id: string; slug: string };
  let counter = 0;
  const server = () => app.getHttpServer();
  const auth = (token = agent.apiKey) => ({ Authorization: `Bearer ${token}` });
  const root = () => auth(world.tokens.root);
  const base = () => `/api/projects/${p.slug}`;
  const pending = (res: request.Response) => { expect(res.status).toBe(202); return data<Pending>(res); };
  const approve = async (id: string) => data<Settled>(await request(server()).post(`/api/approvals/${id}/decisions`).set(root()).send({ decision: 'approve' }).expect(200));
  const ticket = async () => data<{ id: string; ref: string }>(await request(server()).post(`${base()}/tickets`).set(root()).send({ type: 'BUG', title: `label gate ${++counter}` }).expect(201));
  const label = async (slug = p.slug) => data<{ id: string; name: string }>(await request(server()).post(`/api/projects/${slug}/labels`).set(root()).send({ name: `label ${++counter}` }).expect(201));
  const url = () => `https://github.com/acme/repo/pull/${++counter}`;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    p = data(await request(server()).post('/api/projects').set(root()).send({ name: 'Label gates', slug: 'label-gates', key: 'LG' }).expect(201));
    other = data(await request(server()).post('/api/projects').set(root()).send({ name: 'Other labels', slug: 'other-labels', key: 'OL' }).expect(201));
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'label.create', 'label.update', 'ticket.label.assign', 'ticket.link.add'], p.id);
    await app.get(PermissionCache).invalidate();
  }, 60000);
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
    await db.label.deleteMany({ where: { projectId: p.id, name: 'bug' } });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await app?.close(); });

  it('AC-1: agent label creation waits under its policy', async () => {
    await seedWaitPolicy(db, 'label.create', p.id);
    const summary = pending(await request(server()).post(`${base()}/labels`).set(auth()).send({ name: 'bug' }));
    expect(summary.permissionKey).toBe('label.create');
    expect(await db.label.count({ where: { projectId: p.id, name: 'bug' } })).toBe(0);
  });
  it('AC-2: independent label creation executes on approval', async () => {
    await seedWaitPolicy(db, 'label.create', p.id);
    const summary = pending(await request(server()).post(`${base()}/labels`).set(auth()).send({ name: 'bug' }));
    expect(await approve(summary.id)).toMatchObject({ status: 'executed', result: { name: 'bug' } });
    expect(await db.label.count({ where: { projectId: p.id, name: 'bug' } })).toBe(1);
  });
  it('AC-3: label update executes on approval', async () => {
    const row = await label();
    await seedWaitPolicy(db, 'label.update', p.id);
    const summary = pending(await request(server()).patch(`${base()}/labels/${row.id}`).set(auth()).send({ name: 'defect' }));
    expect(await approve(summary.id)).toMatchObject({ status: 'executed' });
    expect(await db.label.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ name: 'defect' });
  });
  it('AC-4: cross-project label update fails at execution without mutation', async () => {
    const row = await label(other.slug);
    await seedWaitPolicy(db, 'label.update', p.id);
    const summary = pending(await request(server()).patch(`${base()}/labels/${row.id}`).set(auth()).send({ name: 'defect' }));
    expect(await approve(summary.id)).toMatchObject({ status: 'failed', result: { error: 'execution-failed', name: new NotFoundAppException().name } });
    expect(await db.label.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ name: row.name });
  });
  it('AC-5: approved assignment adds the label to the ticket', async () => {
    const t = await ticket();
    const l = await label();
    await seedWaitPolicy(db, 'ticket.label.assign', p.id);
    const summary = pending(await request(server()).post(`${base()}/tickets/${t.ref}/labels`).set(auth()).send({ labelId: l.id }));
    expect(await db.ticketLabel.count({ where: { ticketId: t.id, labelId: l.id } })).toBe(0);
    expect(await approve(summary.id)).toMatchObject({ status: 'executed' });
    expect(await db.ticketLabel.count({ where: { ticketId: t.id, labelId: l.id } })).toBe(1);
  });
  it('AC-6: deferred link records the requesting agent, not the decider', async () => {
    const t = await ticket();
    const target = url();
    await seedWaitPolicy(db, 'ticket.link.add', p.id);
    const summary = pending(await request(server()).post(`${base()}/tickets/${t.ref}/links`).set(auth()).send({ url: target }));
    expect(await approve(summary.id)).toMatchObject({ status: 'executed', result: { url: target } });
    const links = await db.ticketLink.findMany({ where: { ticketId: t.id, url: target }, take: 2 });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ createdByAgentId: agent.id, createdByUserId: null });
  });
  it('AC-7: deleting the ticket while waiting fails the approved link execution', async () => {
    const t = await ticket();
    const target = url();
    await seedWaitPolicy(db, 'ticket.link.add', p.id);
    const summary = pending(await request(server()).post(`${base()}/tickets/${t.ref}/links`).set(auth()).send({ url: target }));
    await request(server()).delete(`${base()}/tickets/${t.ref}`).set(root()).expect(200);
    expect((await db.ticket.findUniqueOrThrow({ where: { id: t.id } })).deletedAt).not.toBeNull();
    expect(await approve(summary.id)).toMatchObject({ status: 'failed', result: { error: 'execution-failed', name: new NotFoundAppException({}, 'ticket-links').name } });
    expect(await db.ticketLink.count({ where: { ticketId: t.id, url: target } })).toBe(0);
  });
  it('AC-8: root duplicate link remains immediate 200 with no approval row', async () => {
    const t = await ticket();
    const target = url();
    await seedWaitPolicy(db, 'ticket.link.add', p.id);
    const first = data<{ id: string }>(await request(server()).post(`${base()}/tickets/${t.ref}/links`).set(root()).send({ url: target }).expect(201));
    const duplicate = data<{ id: string }>(await request(server()).post(`${base()}/tickets/${t.ref}/links`).set(root()).send({ url: target }).expect(200));
    expect(duplicate).toEqual(first);
    expect(await db.approvalRequest.count()).toBe(0);
  });
});

import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
interface Pending { id: string; permissionKey: string; projectId: string }
interface Settled { status: string; result: unknown }
interface Ticket { id: string; ref: string; status: string }

describeIntegration('gated ticket transition routes', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let project: { id: string; slug: string };
  let counter = 0;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const agentAuth = () => auth(agent.apiKey);
  const rootAuth = () => auth(world.tokens.root);
  const path = (ref: string) => `/api/projects/${project.slug}/tickets/${ref}`;
  const pending = (res: request.Response) => { expect(res.status).toBe(202); return data<Pending>(res); };
  const approve = async (id: string) => data<Settled>(await request(server()).post(`/api/approvals/${id}/decisions`).set(rootAuth()).send({ decision: 'approve' }).expect(200));
  const createTicket = async (): Promise<Ticket> => data<Ticket>(await request(server()).post(`/api/projects/${project.slug}/tickets`).set(rootAuth()).send({ type: 'BUG', title: `transition ${++counter}` }).expect(201));
  const verifyAsRoot = async (ref: string) => request(server()).post(`${path(ref)}/verify`).set(rootAuth()).send({ body: 'root verified' }).expect(200);
  const transitionFailure = () => ({ status: 'failed', result: { error: 'execution-failed', name: expect.any(String) } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    project = data(await request(server()).post('/api/projects').set(rootAuth()).send({ name: 'Ticket transitions', slug: 'ticket-transitions', key: 'TT' }).expect(201));
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, [
      'project.read', 'ticket.transition.verify', 'ticket.transition.start', 'ticket.transition.fix',
    ], project.id);
    await app.get(PermissionCache).invalidate();
  }, 60000);
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });
  afterAll(async () => { await app?.close(); });

  it('AC-1: verify returns pending under the route-key wait policy', async () => {
    const ticket = await createTicket();
    await seedWaitPolicy(db, 'ticket.transition.verify', project.id);
    const summary = pending(await request(server()).post(`${path(ticket.ref)}/verify`).set(agentAuth()).send({ body: 'ok' }));
    expect(summary).toMatchObject({ permissionKey: 'ticket.transition.verify', projectId: project.id });
  });

  it('AC-2: repeating verify while pending leaves the ticket CREATED', async () => {
    const ticket = await createTicket();
    await seedWaitPolicy(db, 'ticket.transition.verify', project.id);
    const body = { body: 'still waiting' };
    pending(await request(server()).post(`${path(ticket.ref)}/verify`).set(agentAuth()).send(body));
    pending(await request(server()).post(`${path(ticket.ref)}/verify`).set(agentAuth()).send(body));
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('CREATED');
  });

  it('AC-3: approval verifies and persists the required comment', async () => {
    const ticket = await createTicket();
    await seedWaitPolicy(db, 'ticket.transition.verify', project.id);
    const summary = pending(await request(server()).post(`${path(ticket.ref)}/verify`).set(agentAuth()).send({ body: 'ok' }));
    expect(await approve(summary.id)).toMatchObject({ status: 'executed', result: { status: 'VERIFIED' } });
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('VERIFIED');
    expect(await db.comment.findFirst({ where: { ticketId: ticket.id, body: 'ok' } })).not.toBeNull();
  });

  it('AC-4: approval starts a VERIFIED ticket', async () => {
    const ticket = await createTicket();
    await verifyAsRoot(ticket.ref);
    await seedWaitPolicy(db, 'ticket.transition.start', project.id);
    const summary = pending(await request(server()).post(`${path(ticket.ref)}/start`).set(agentAuth()).send({}));
    expect(await approve(summary.id)).toMatchObject({ status: 'executed', result: { status: 'IN_PROGRESS' } });
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('IN_PROGRESS');
  });

  it('AC-5: approval submits a fix for an IN_PROGRESS ticket', async () => {
    const ticket = await createTicket();
    await verifyAsRoot(ticket.ref);
    await request(server()).post(`${path(ticket.ref)}/start`).set(rootAuth()).send({}).expect(200);
    await seedWaitPolicy(db, 'ticket.transition.fix', project.id);
    const summary = pending(await request(server()).post(`${path(ticket.ref)}/fix`).set(agentAuth()).send({ body: 'fixed' }));
    expect(await approve(summary.id)).toMatchObject({ status: 'executed', result: { status: 'VERIFY_FIX' } });
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('VERIFY_FIX');
  });

  it('AC-6: blank verify body is rejected before a request is created', async () => {
    const ticket = await createTicket();
    await seedWaitPolicy(db, 'ticket.transition.verify', project.id);
    await request(server()).post(`${path(ticket.ref)}/verify`).set(agentAuth()).send({ body: '  ' }).expect(400);
    expect(await db.approvalRequest.count()).toBe(0);
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('CREATED');
  });

  it('AC-7: verify approved after a concurrent root verification settles failed', async () => {
    const ticket = await createTicket();
    await seedWaitPolicy(db, 'ticket.transition.verify', project.id);
    const summary = pending(await request(server()).post(`${path(ticket.ref)}/verify`).set(agentAuth()).send({ body: 'agent verify' }));
    await verifyAsRoot(ticket.ref);
    expect(await approve(summary.id)).toMatchObject(transitionFailure());
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('VERIFIED');
  });
});

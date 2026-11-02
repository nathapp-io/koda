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
interface Pending { id: string; permissionKey: string; projectId: string; requiredMode: string }
interface Settled { status: string; result: unknown }
interface Ticket { id: string; ref: string; status: string }

describeIntegration('gated ticket review routes', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let returnOnly: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let distinctApprover: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let project: { id: string; slug: string };
  let counter = 0;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const agentAuth = (token = agent.apiKey) => auth(token);
  const rootAuth = () => auth(world.tokens.root);
  const path = (ref: string) => `/api/projects/${project.slug}/tickets/${ref}`;
  const pending = (res: request.Response) => { expect(res.status).toBe(202); return data<Pending>(res); };
  const approve = async (id: string) => data<Settled>(await request(server()).post(`/api/approvals/${id}/decisions`).set(rootAuth()).send({ decision: 'approve' }).expect(200));
  const createTicket = async (): Promise<Ticket> => data<Ticket>(await request(server()).post(`/api/projects/${project.slug}/tickets`).set(rootAuth()).send({ type: 'BUG', title: `review ${++counter}` }).expect(201));
  const reachVerifyFix = async (ref: string) => {
    await request(server()).post(`${path(ref)}/verify`).set(rootAuth()).send({ body: 'verified' }).expect(200);
    await request(server()).post(`${path(ref)}/start`).set(rootAuth()).send({}).expect(200);
    await request(server()).post(`${path(ref)}/fix`).set(rootAuth()).send({ body: 'fixed' }).expect(200);
  };
  const reachAgentVerifyFix = async (ref: string) => {
    await request(server()).post(`${path(ref)}/verify`).set(rootAuth()).send({ body: 'verified' }).expect(200);
    await request(server()).post(`${path(ref)}/start`).set(rootAuth()).send({}).expect(200);
    await request(server()).post(`${path(ref)}/fix`).set(agentAuth()).send({ body: 'agent fixed' }).expect(200);
  };
  const checkStatus = async (ticketId: string, status: string) => expect((await db.ticket.findUniqueOrThrow({ where: { id: ticketId } })).status).toBe(status);

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    project = data(await request(server()).post('/api/projects').set(rootAuth()).send({ name: 'Ticket review', slug: 'ticket-review', key: 'TR' }).expect(201));
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    returnOnly = await seedFleetHttpAgent(server(), world.tokens.root);
    distinctApprover = await seedFleetHttpAgent(server(), world.tokens.root);
    const keys = ['ticket.transition.verify-fix.approve', 'ticket.transition.verify-fix.return', 'ticket.transition.close', 'ticket.transition.reject', 'ticket.transition.fix', 'ticket.transition.verify'];
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', ...keys], project.id);
    await grantKeys(db, { type: 'AGENT', id: returnOnly.id }, ['project.read', 'ticket.transition.verify-fix.return'], project.id);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['approval.decide'], project.id);
    await grantKeys(db, { type: 'AGENT', id: distinctApprover.id }, ['project.read', 'ticket.transition.verify-fix.approve'], project.id);
    await app.get(PermissionCache).invalidate();
  }, 60000);
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });
  afterAll(async () => { await app?.close(); });

  it('AC-1/2: approve key waits and approval closes its independently pending ticket', async () => {
    const first = await createTicket(); await reachVerifyFix(first.ref);
    await seedWaitPolicy(db, 'ticket.transition.verify-fix.approve', project.id);
    const firstPending = pending(await request(server()).post(`${path(first.ref)}/verify-fix?approve=true`).set(agentAuth()).send({ body: 'good' }));
    expect(firstPending.permissionKey).toBe('ticket.transition.verify-fix.approve');
    const second = await createTicket(); await reachVerifyFix(second.ref);
    const secondPending = pending(await request(server()).post(`${path(second.ref)}/verify-fix?approve=true`).set(agentAuth()).send({ body: 'good' }));
    expect(await approve(secondPending.id)).toMatchObject({ status: 'executed', result: { status: 'CLOSED' } });
    await checkStatus(second.id, 'CLOSED');
  });
  it('AC-3/4: return key waits by default and approval leaves ticket IN_PROGRESS', async () => {
    const first = await createTicket(); await reachVerifyFix(first.ref);
    await seedWaitPolicy(db, 'ticket.transition.verify-fix.return', project.id);
    const firstPending = pending(await request(server()).post(`${path(first.ref)}/verify-fix`).set(agentAuth()).send({ body: 'redo' }));
    expect(firstPending.permissionKey).toBe('ticket.transition.verify-fix.return');
    const second = await createTicket(); await reachVerifyFix(second.ref);
    const secondPending = pending(await request(server()).post(`${path(second.ref)}/verify-fix`).set(agentAuth()).send({ body: 'redo' }));
    expect(await approve(secondPending.id)).toMatchObject({ status: 'executed', result: { status: 'IN_PROGRESS' } });
    await checkStatus(second.id, 'IN_PROGRESS');
  });
  it('AC-5: missing selected approve key is refused without opening a request', async () => {
    const ticket = await createTicket(); await reachVerifyFix(ticket.ref);
    const response = await request(server()).post(`${path(ticket.ref)}/verify-fix?approve=true`).set(agentAuth(returnOnly.apiKey)).send({ body: 'good' }).expect(403);
    expect(response.body.ret).toBe(40003);
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('AC-6/7: close and reject execute after approval', async () => {
    const closing = await createTicket();
    await request(server()).post(`${path(closing.ref)}/verify`).set(rootAuth()).send({ body: 'verified' }).expect(200);
    await request(server()).post(`${path(closing.ref)}/start`).set(rootAuth()).send({}).expect(200);
    await seedWaitPolicy(db, 'ticket.transition.close', project.id);
    const closeRequest = pending(await request(server()).post(`${path(closing.ref)}/close`).set(agentAuth()).send({ body: 'done' }));
    expect(await approve(closeRequest.id)).toMatchObject({ status: 'executed', result: { status: 'CLOSED' } });
    await checkStatus(closing.id, 'CLOSED');

    const rejecting = await createTicket();
    await seedWaitPolicy(db, 'ticket.transition.reject', project.id);
    const rejectRequest = pending(await request(server()).post(`${path(rejecting.ref)}/reject`).set(agentAuth()).send({ body: 'no' }));
    expect(await approve(rejectRequest.id)).toMatchObject({ status: 'executed', result: { status: 'REJECTED' } });
    await checkStatus(rejecting.id, 'REJECTED');
  });
  it('AC-7–14: self-fix agent is parked on approve, verify and close, and cannot decide its own request', async () => {
    const approveTicket = await createTicket();
    await reachAgentVerifyFix(approveTicket.ref);
    const approveRequest = pending(await request(server()).post(`${path(approveTicket.ref)}/verify-fix?approve=true`).set(agentAuth()).send({ body: 'approve' }));
    expect(approveRequest).toMatchObject({ permissionKey: 'ticket.transition.verify-fix.approve', requiredMode: 'agent' });
    await checkStatus(approveTicket.id, 'VERIFY_FIX');
    await request(server()).post(`/api/approvals/${approveRequest.id}/decisions`).set(agentAuth()).send({ decision: 'approve' }).expect(403);
    await checkStatus(approveTicket.id, 'VERIFY_FIX');

    const verifyTicket = await createTicket();
    await reachAgentVerifyFix(verifyTicket.ref);
    const verifyRequest = pending(await request(server()).post(`${path(verifyTicket.ref)}/verify`).set(agentAuth()).send({ body: 'verify' }));
    expect(verifyRequest).toMatchObject({ permissionKey: 'ticket.transition.verify', requiredMode: 'agent' });
    await checkStatus(verifyTicket.id, 'VERIFY_FIX');

    const closeTicket = await createTicket();
    await reachAgentVerifyFix(closeTicket.ref);
    const closeRequest = pending(await request(server()).post(`${path(closeTicket.ref)}/close`).set(agentAuth()).send({ body: 'close' }));
    expect(closeRequest).toMatchObject({ permissionKey: 'ticket.transition.close', requiredMode: 'agent' });
    await checkStatus(closeTicket.id, 'VERIFY_FIX');
  });

  it('AC-15/16: a distinct authorized agent can approve another agent\'s fix', async () => {
    const ticket = await createTicket();
    await reachAgentVerifyFix(ticket.ref);
    const response = await request(server()).post(`${path(ticket.ref)}/verify-fix?approve=true`).set(agentAuth(distinctApprover.apiKey)).send({ body: 'approve' }).expect(200);
    expect(data<Ticket>(response)).toMatchObject({ status: 'CLOSED' });
    await checkStatus(ticket.id, 'CLOSED');
  });

  it('AC-17/18: root can approve a root-submitted fix immediately', async () => {
    const ticket = await createTicket();
    await reachVerifyFix(ticket.ref);
    const response = await request(server()).post(`${path(ticket.ref)}/verify-fix?approve=true`).set(rootAuth()).send({ body: 'approve' }).expect(200);
    expect(data<Ticket>(response)).toMatchObject({ status: 'CLOSED' });
    await checkStatus(ticket.id, 'CLOSED');
  });

  it('AC-8: blank close body is rejected before an approval request exists', async () => {
    const ticket = await createTicket();
    await seedWaitPolicy(db, 'ticket.transition.close', project.id);
    await request(server()).post(`${path(ticket.ref)}/close`).set(agentAuth()).send({ body: '' }).expect(400);
    expect(await db.approvalRequest.count()).toBe(0);
  });
});

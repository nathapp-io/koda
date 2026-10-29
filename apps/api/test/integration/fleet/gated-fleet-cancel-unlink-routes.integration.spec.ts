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
const jobs = '/api/projects/web/fleet/jobs';
describeIntegration('gated fleet cancel and ticket unlink', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let keyed: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let requester: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const cancel = (id: string, token = keyed.apiKey) => request(server()).post(`${jobs}/${id}/cancel`).set(auth(token));
  const unlink = (ref: string, id: string, token = keyed.apiKey) => request(server()).delete(`/api/projects/web/tickets/${ref}/fleet-jobs/${id}`).set(auth(token));
  const wait = (key = 'fleet.job.cancel') => seedWaitPolicy(db, key, world.projectId);
  const approve = async (id: string) => data<{ status: string }>(await request(server()).post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200));
  const insert = (feature: string, requestedById = world.ids.dev) => db.fleetJob.create({ data: {
    projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature, profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById,
  } });
  const linked = async (feature: string) => {
    const ticket = data<{ id: string; ref: string }>(await request(server()).post('/api/projects/web/tickets').set(auth(world.tokens.root)).send({ type: 'TASK', title: feature }).expect(201));
    const { job } = data<{ job: { id: string } }>(await request(server()).post(jobs).set(auth(world.tokens.root)).send({ repoId: world.repoId, command: 'RUN', feature, maxCostUsd: 5, ticketRefs: [ticket.ref] }).expect(201));
    return { ticket, job };
  };
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    keyed = await seedFleetHttpAgent(server(), world.tokens.root);
    requester = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: keyed.id }, ['project.read', 'fleet.job.cancel', 'fleet.ticket-job.unlink'], world.projectId);
    await grantKeys(db, { type: 'AGENT', id: requester.id }, ['project.read', 'fleet.job.dispatch'], world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
    await db.fleetJob.deleteMany();
  });
  it('AC-1: keyed cancellation waits', async () => {
    await wait();
    const job = await insert('cancel-1');
    expect(data<Pending>(await cancel(job.id).expect(202))).toMatchObject({ permissionKey: 'fleet.job.cancel', projectId: world.projectId });
  });
  it('AC-2: approved keyed cancellation stores the cancelled result', async () => {
    await wait();
    const job = await insert('cancel-2');
    const pending = data<Pending>(await cancel(job.id).expect(202));
    expect((await approve(pending.id)).status).toBe('executed');
    expect(await db.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ state: 'CANCELLED' });
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: pending.id } })).result).toMatchObject({ state: 'CANCELLED' });
  });
  it('AC-3: requester without the cancel key waits on its own job', async () => {
    await wait();
    const job = await insert('cancel-3', requester.id);
    expect(data<Pending>(await cancel(job.id, requester.apiKey).expect(202)).permissionKey).toBe('fleet.job.cancel');
  });
  it('AC-4: requester cancellation executes without a cancel key', async () => {
    await wait();
    const job = await insert('cancel-4', requester.id);
    const pending = data<Pending>(await cancel(job.id, requester.apiKey).expect(202));
    expect((await approve(pending.id)).status).toBe('executed');
    expect(await db.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ state: 'CANCELLED' });
  });
  it('AC-5: nonrequester without a key is refused before opening a request', async () => {
    await wait();
    const job = await insert('cancel-5');
    expect((await cancel(job.id, requester.apiKey).expect(403)).body).toMatchObject({ ret: 40003, message: 'You do not have permissions to perform this action' });
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('AC-6: missing job is refused before opening a request', async () => {
    await wait();
    expect((await cancel('unknown-job').expect(404)).body).toMatchObject({ ret: 404, message: 'Fleet job not found' });
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('AC-7: a job cancelled while waiting fails settlement', async () => {
    await wait();
    const job = await insert('cancel-7');
    const pending = data<Pending>(await cancel(job.id).expect(202));
    await cancel(job.id, world.tokens.root).expect(200);
    expect((await approve(pending.id)).status).toBe('failed');
  });
  it('AC-8: linked job unlink waits', async () => {
    await wait('fleet.ticket-job.unlink');
    const { ticket, job } = await linked('unlink-8');
    expect(data<Pending>(await unlink(ticket.ref, job.id).expect(202)).permissionKey).toBe('fleet.ticket-job.unlink');
  });
  it('AC-9: approval removes the link', async () => {
    await wait('fleet.ticket-job.unlink');
    const { ticket, job } = await linked('unlink-9');
    const pending = data<Pending>(await unlink(ticket.ref, job.id).expect(202));
    expect((await approve(pending.id)).status).toBe('executed');
    expect(data<unknown[]>(await request(server()).get(`/api/projects/web/tickets/${ticket.ref}/fleet-jobs`).set(auth(world.tokens.root)).expect(200))).toEqual([]);
  });
  it('AC-10: root unlink is immediate and bodyless under a wait policy', async () => {
    await wait('fleet.ticket-job.unlink');
    const { ticket, job } = await linked('unlink-10');
    expect((await unlink(ticket.ref, job.id, world.tokens.root).expect(204)).text).toBe('');
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('AC-15: a link removed while waiting fails settlement', async () => {
    await wait('fleet.ticket-job.unlink');
    const { ticket, job } = await linked('unlink-15');
    const pending = data<Pending>(await unlink(ticket.ref, job.id).expect(202));
    await unlink(ticket.ref, job.id, world.tokens.root).expect(204);
    expect((await approve(pending.id)).status).toBe('failed');
  });
});

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
interface Decided { status: string; result: { job?: { id: string }; error?: string } }
const jobs = '/api/projects/web/fleet/jobs';
describeIntegration('gated fleet dispatch and requeue', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const body = (feature: string) => ({ repoId: world.repoId, command: 'RUN', feature, maxCostUsd: 5 });
  const dispatch = (feature: string, token = agent.apiKey, extra: object = {}) => request(server()).post(jobs).set(auth(token)).send({ ...body(feature), ...extra });
  const wait = (key = 'fleet.job.dispatch') => seedWaitPolicy(db, key, world.projectId);
  const open = async (feature: string, extra: object = {}) => data<Pending>(await dispatch(feature, agent.apiKey, extra).expect(202));
  const approve = async (id: string) => data<Decided>(await request(server()).post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200));
  const cancelled = async (feature: string) => {
    const { job } = data<{ job: { id: string } }>(await dispatch(feature, world.tokens.root).expect(201));
    await request(server()).post(`${jobs}/${job.id}/cancel`).set(auth(world.tokens.root)).expect(200);
    return job;
  };
  const requeue = (id: string) => request(server()).post(`${jobs}/${id}/requeue`).set(auth(agent.apiKey));
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'fleet.job.dispatch', 'fleet.job.requeue'], world.projectId);
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
  it('AC-1: agent dispatch waits under an explicit policy', async () => {
    await wait();
    expect(await open('ac-1')).toMatchObject({ permissionKey: 'fleet.job.dispatch', projectId: world.projectId });
  });
  it('AC-2: pending dispatch has not created a job', async () => {
    await wait();
    await open('ac-2');
    expect(await db.fleetJob.count({ where: { feature: 'ac-2' } })).toBe(0);
  });
  it('AC-3: approval creates exactly one queued job as the requester and stores its id', async () => {
    await wait();
    const pending = await open('ac-3');
    expect((await approve(pending.id)).status).toBe('executed');
    expect(await db.fleetJob.count({ where: { feature: 'ac-3' } })).toBe(1);
    const job = await db.fleetJob.findFirstOrThrow({ where: { feature: 'ac-3' } });
    expect(job).toMatchObject({ state: 'QUEUED', requestedById: agent.id });
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: pending.id } })).result).toMatchObject({ job: { id: job.id } });
  });
  it('AC-4: approved RUN starts its independently created ticket after commit', async () => {
    await wait();
    const ticket = data<{ id: string; ref: string }>(await request(server()).post('/api/projects/web/tickets').set(auth(world.tokens.root)).send({ type: 'TASK', title: 'AC-4 independent ticket' }).expect(201));
    expect(await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({ status: 'CREATED' });
    const pending = await open('ac-4', { ticketRefs: [ticket.ref] });
    expect(await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({ status: 'CREATED' });
    expect((await approve(pending.id)).status).toBe('executed');
    expect(await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({ status: 'IN_PROGRESS' });
  });
  it('AC-5: a duplicate created while waiting fails settlement without a second job', async () => {
    await wait();
    const pending = await open('ac-5');
    await dispatch('ac-5', world.tokens.root).expect(201);
    expect(await approve(pending.id)).toMatchObject({ status: 'failed' });
    expect(await db.fleetJob.count({ where: { feature: 'ac-5' } })).toBe(1);
  });
  it('AC-6: root bypasses a wait policy without an approval request', async () => {
    await wait();
    await dispatch('ac-6', world.tokens.root).expect(201);
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('AC-7: requeue of a cancelled job waits', async () => {
    await wait('fleet.job.requeue');
    const job = await cancelled('ac-7');
    expect(data<Pending>(await requeue(job.id).expect(202))).toMatchObject({ permissionKey: 'fleet.job.requeue' });
    expect(await db.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ state: 'CANCELLED' });
  });
  it('AC-8: approving requeue leaves the job queued', async () => {
    await wait('fleet.job.requeue');
    const job = await cancelled('ac-8');
    const pending = data<Pending>(await requeue(job.id).expect(202));
    expect((await approve(pending.id)).status).toBe('executed');
    expect(await db.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ state: 'QUEUED' });
  });
  it('AC-9: freezes the REST variant, slug, project and validated body', async () => {
    await wait();
    const pending = await open('ac-9');
    expect(await db.approvalRequest.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ variant: 'rest:fleet-jobs.dispatch', input: { slug: 'web', projectId: world.projectId, dispatch: body('ac-9') } });
  });
  it('AC-15: agent dispatch without a policy is immediate with no request', async () => {
    await dispatch('ac-15').expect(201);
    expect(await db.approvalRequest.count()).toBe(0);
    expect(await db.fleetJob.findFirstOrThrow({ where: { feature: 'ac-15' } })).toMatchObject({ requestedById: agent.id });
  });
});

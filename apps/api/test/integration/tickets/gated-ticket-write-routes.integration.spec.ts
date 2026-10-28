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

describeIntegration('gated ticket write routes', () => {
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
  const path = () => `/api/projects/${project.slug}/tickets`;
  const create = (title: string, token = agent.apiKey) => request(server()).post(path()).set(auth(token)).send({ type: 'BUG', title });
  const pending = (res: request.Response) => { expect(res.status).toBe(202); return data<Pending>(res); };
  const approve = async (id: string) => data<Settled>(await request(server()).post(`/api/approvals/${id}/decisions`).set(rootAuth()).send({ decision: 'approve' }).expect(200));

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    project = data(await request(server()).post('/api/projects').set(rootAuth()).send({ name: 'Ticket writes', slug: 'ticket-writes', key: 'TW' }).expect(201));
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'ticket.create', 'ticket.update', 'ticket.assign'], project.id);
    await app.get(PermissionCache).invalidate();
  }, 60000);
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });
  afterAll(async () => { await app?.close(); });

  it('AC-1: agent ticket creation waits under a policy', async () => {
    await seedWaitPolicy(db, 'ticket.create', project.id);
    const summary = pending(await create(`pending ${++counter}`));
    expect(summary).toMatchObject({ permissionKey: 'ticket.create', projectId: project.id });
  });

  it('AC-2: approving pending create writes a ticket attributed to its agent', async () => {
    await seedWaitPolicy(db, 'ticket.create', project.id);
    const title = `approved create ${++counter}`;
    const summary = pending(await create(title));
    expect(await approve(summary.id)).toMatchObject({ status: 'executed' });
    expect(await db.ticket.count({ where: { projectId: project.id, title, createdByAgentId: agent.id } })).toBe(1);
  });

  it('AC-3: approving pending title update changes the ticket', async () => {
    const created = data<{ id: string; ref: string }>(await create(`before update ${++counter}`, world.tokens.root).expect(201));
    await seedWaitPolicy(db, 'ticket.update', project.id);
    const summary = pending(await request(server()).patch(`${path()}/${created.ref}`).set(agentAuth()).send({ title: 'renamed' }));
    expect(await approve(summary.id)).toMatchObject({ status: 'executed' });
    expect((await db.ticket.findUniqueOrThrow({ where: { id: created.id } })).title).toBe('renamed');
  });

  it('AC-4: approved status patch fails when the agent lacks the edge key', async () => {
    const created = data<{ ref: string }>(await create(`status refusal ${++counter}`, world.tokens.root).expect(201));
    await seedWaitPolicy(db, 'ticket.update', project.id);
    const summary = pending(await request(server()).patch(`${path()}/${created.ref}`).set(agentAuth()).send({ status: 'IN_PROGRESS' }));
    expect(await approve(summary.id)).toMatchObject({ status: 'failed', result: { error: 'execution-failed', name: expect.any(String) } });
  });

  it('AC-5: approving pending assignment assigns the agent', async () => {
    const created = data<{ id: string; ref: string }>(await create(`assignment ${++counter}`, world.tokens.root).expect(201));
    await seedWaitPolicy(db, 'ticket.assign', project.id);
    const summary = pending(await request(server()).post(`${path()}/${created.ref}/assign`).set(agentAuth()).send({ agentId: agent.id }));
    expect(await approve(summary.id)).toMatchObject({ status: 'executed' });
    expect((await db.ticket.findUniqueOrThrow({ where: { id: created.id } })).assignedToAgentId).toBe(agent.id);
  });

  it('AC-6: agent creates immediately without policy or an approval request', async () => {
    const title = `no policy ${++counter}`;
    await create(title).expect(201);
    expect(await db.approvalRequest.count()).toBe(0);
    expect(await db.ticket.count({ where: { projectId: project.id, title } })).toBe(1);
  });

  it('AC-7: root creates immediately under an agent wait policy', async () => {
    await seedWaitPolicy(db, 'ticket.create', project.id);
    await create(`root direct ${++counter}`, world.tokens.root).expect(201);
    expect(await db.approvalRequest.count()).toBe(0);
  });
});

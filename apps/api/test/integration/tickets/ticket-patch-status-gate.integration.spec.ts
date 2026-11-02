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

describeIntegration('ticket PATCH status approval gate', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let project: { id: string; slug: string };
  let counter = 0;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rootAuth = () => auth(world.tokens.root);
  const agentAuth = () => auth(agent.apiKey);
  const path = (ref: string) => `/api/projects/${project.slug}/tickets/${ref}`;
  const create = async (): Promise<{ id: string; ref: string }> => {
    const title = `status gate ${++counter}`;
    const previous = await db.ticket.aggregate({ where: { projectId: project.id }, _max: { number: true } });
    const ticket = await db.ticket.create({ data: {
      projectId: project.id,
      number: (previous._max.number ?? 0) + 1,
      type: 'BUG',
      title,
      createdByUserId: world.ids.root,
    }, select: { id: true, number: true } });
    return { id: ticket.id, ref: `SG-${ticket.number}` };
  };
  const addEdgeGrant = async () => {
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['ticket.transition.start'], project.id);
    await app.get(PermissionCache).invalidate();
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    project = data(await request(server()).post('/api/projects').set(rootAuth())
      .send({ name: 'Status gate', slug: 'status-gate', key: 'SG' }).expect(201));
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'ticket.update'], project.id);
    await app.get(PermissionCache).invalidate();
  }, 60000);
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });
  afterAll(async () => { await app?.close(); });

  it('AC-6/7/8: edge policy parks and leaves the ticket CREATED', async () => {
    await addEdgeGrant();
    await seedWaitPolicy(db, 'ticket.transition.start', project.id);
    const ticket = await create();
    const response = await request(server()).patch(path(ticket.ref)).set(agentAuth()).send({ status: 'IN_PROGRESS' }).expect(202);
    expect(data<Pending>(response)).toMatchObject({ permissionKey: 'ticket.transition.start', projectId: project.id });
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('CREATED');
  });

  it('AC-9/10: ticket.update policy parks status PATCH without an edge policy', async () => {
    await addEdgeGrant();
    await seedWaitPolicy(db, 'ticket.update', project.id);
    const ticket = await create();
    const response = await request(server()).patch(path(ticket.ref)).set(agentAuth()).send({ status: 'IN_PROGRESS' }).expect(202);
    expect(data<Pending>(response)).toMatchObject({ permissionKey: 'ticket.transition.start', projectId: project.id });
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('CREATED');
  });

  it('AC-11/12: root status PATCH executes and persists IN_PROGRESS', async () => {
    const ticket = await create();
    const response = await request(server()).patch(path(ticket.ref)).set(rootAuth()).send({ status: 'IN_PROGRESS' }).expect(200);
    expect(data<{ status: string }>(response).status).toBe('IN_PROGRESS');
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('IN_PROGRESS');
  });

  it('AC-13/15: missing edge permission is refused without opening an approval request', async () => {
    await db.roleBinding.deleteMany({ where: { principalType: 'AGENT', principalId: agent.id, projectId: project.id } });
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'ticket.update'], project.id);
    await app.get(PermissionCache).invalidate();
    await seedWaitPolicy(db, 'ticket.update', project.id);
    const ticket = await create();
    await request(server()).patch(path(ticket.ref)).set(agentAuth()).send({ status: 'IN_PROGRESS' }).expect(403);
    expect(await db.approvalRequest.count({ where: { permissionKey: 'ticket.transition.start' } })).toBe(0);
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('CREATED');
  });
});

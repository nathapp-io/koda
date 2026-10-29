import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('gated ticket watch routes', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let project: { id: string; slug: string };
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let userToken: string;
  let ticketNumber = 0;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rootAuth = () => auth(world.tokens.root);
  const makeTicket = async () => {
    ticketNumber += 1;
    return data<{ ref: string }>(await request(server()).post(`/api/projects/${project.slug}/tickets`).set(rootAuth())
      .send({ type: 'BUG', title: `watch ${ticketNumber}` }).expect(201));
  };
  const watchPath = (ref: string) => `/api/projects/${project.slug}/tickets/${ref}/watch`;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    project = data(await request(server()).post('/api/projects').set(rootAuth())
      .send({ name: 'Watch gates', slug: 'watch-gates', key: 'WG' }).expect(201));
    await request(server()).post('/api/admin/users').set(rootAuth())
      .send({ email: 'watch-dev@example.test', name: 'Watch Dev', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    userToken = await loginToken(server(), 'watch-dev@example.test');
    await request(server()).post(`/api/projects/${project.slug}/members`).set(rootAuth())
      .send({ email: 'watch-dev@example.test', roleKey: 'developer' }).expect(201);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'ticket.watch.set', 'ticket.watch.unset'], project.id);
    await app.get(PermissionCache).invalidate();
  }, 60000);

  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });
  afterAll(async () => { await app?.close(); });

  it('AC-1: developer watches immediately without an approval request', async () => {
    const { ref } = await makeTicket();
    expect(data<{ watching: boolean }>(await request(server()).put(watchPath(ref)).set(auth(userToken)).expect(200)).watching).toBe(true);
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('AC-2: developer unwatches immediately', async () => {
    const { ref } = await makeTicket();
    await request(server()).put(watchPath(ref)).set(auth(userToken)).expect(200);
    expect(data<{ watching: boolean }>(await request(server()).delete(watchPath(ref)).set(auth(userToken)).expect(200)).watching).toBe(false);
  });

  it.each([
    ['PUT', 'ticket.watch.set'],
    ['DELETE', 'ticket.watch.unset'],
  ] as const)('AC agent guard: %s refuses before an agent wait request is created', async (method, key) => {
    const { ref } = await makeTicket();
    await seedWaitPolicy(db, key, project.id);
    const response = method === 'PUT'
      ? await request(server()).put(watchPath(ref)).set(auth(agent.apiKey))
      : await request(server()).delete(watchPath(ref)).set(auth(agent.apiKey));
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ ret: 40003, message: 'Notifications are available to signed-in users only' });
    expect(await db.approvalRequest.count()).toBe(0);
  });
});

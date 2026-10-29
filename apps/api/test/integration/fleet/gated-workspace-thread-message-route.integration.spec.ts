import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { FLEET_CFG, type IFleetConfig } from '../../../src/config/fleet.config';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
interface Pending { id: string; permissionKey: string; projectId: string | null }

describeIntegration('gated workspace thread message route (US-008)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let n = 0;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const messageBody = () => ({ text: `message-${++n}`, clientMessageId: `us008-${n}` });
  const pending = (res: request.Response): Pending => {
    expect(res.status).toBe(202);
    const result = data<Pending>(res);
    expect(result).toMatchObject({ permissionKey: 'thread.workspace.message.send', projectId: null });
    return result;
  };
  const approve = async (id: string) => data<{ status: string }>(
    await request(server()).post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200),
  );
  const createThread = async () => db.chatThread.create({ data: {
    kind: 'WORKSPACE', projectId: world.projectId, repoId: null, baseRef: null, feature: null,
    title: `US008-${++n}`, createdById: agent.id, createdByType: 'AGENT', backend: { kind: 'native', model: 'm1' }, skills: [],
  } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    app.get<IFleetConfig>(FLEET_CFG).threadsEnabled = true;
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['thread.workspace.message.send'], null);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read'], world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    await db.roleBinding.deleteMany({ where: { principalType: 'AGENT', principalId: agent.id } });
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['thread.workspace.message.send'], null);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read'], world.projectId);
    await app.get(PermissionCache).invalidate();
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
    await app.get(PermissionCache).invalidate();
  });

  it('AC-1/AC-2: waits globally without inserting a message; approval executes as the agent', async () => {
    const thread = await createThread();
    const body = messageBody();
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['thread.create'], world.projectId);
    await app.get(PermissionCache).invalidate();
    await seedWaitPolicy(db, 'thread.workspace.message.send', null);

    const ask = pending(await request(server()).post(`/api/threads/${thread.id}/messages`).set(auth(agent.apiKey)).send(body));
    expect(await db.chatMessage.count({ where: { threadId: thread.id, clientMessageId: body.clientMessageId } })).toBe(0);
    expect(await approve(ask.id)).toMatchObject({ status: 'executed' });
    const rows = await db.chatMessage.findMany({ where: { threadId: thread.id, clientMessageId: body.clientMessageId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ authorUserId: agent.id, authorType: 'AGENT', content: body.text });
  }, 30_000);

  it('AC-3: approved deferred send rechecks hosting permission and writes nothing after revocation', async () => {
    const thread = await createThread();
    const body = messageBody();
    await seedWaitPolicy(db, 'thread.workspace.message.send', null);
    const hostingGrant = await grantKeys(db, { type: 'AGENT', id: agent.id }, ['thread.create'], world.projectId);
    // Retain project.read; only the home-project hosting permission is removed while the request waits.
    const ask = pending(await request(server()).post(`/api/threads/${thread.id}/messages`).set(auth(agent.apiKey)).send(body));
    await db.roleBinding.delete({ where: { id: hostingGrant.id } });
    await app.get(PermissionCache).invalidate();

    expect(await approve(ask.id)).toMatchObject({ status: 'failed' });
    expect(await db.chatMessage.count({ where: { threadId: thread.id, clientMessageId: body.clientMessageId } })).toBe(0);
  }, 30_000);

  it('AC-4: executes immediately without a policy and returns 200 for the duplicate', async () => {
    const thread = await createThread();
    const body = messageBody();
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['thread.create'], world.projectId);
    await app.get(PermissionCache).invalidate();
    const before = await db.approvalRequest.count();

    await request(server()).post(`/api/threads/${thread.id}/messages`).set(auth(agent.apiKey)).send(body).expect(201);
    expect(await db.approvalRequest.count()).toBe(before);
    await request(server()).post(`/api/threads/${thread.id}/messages`).set(auth(agent.apiKey)).send(body).expect(200);
    expect(await db.chatMessage.count({ where: { threadId: thread.id, clientMessageId: body.clientMessageId } })).toBe(1);
  }, 30_000);
});

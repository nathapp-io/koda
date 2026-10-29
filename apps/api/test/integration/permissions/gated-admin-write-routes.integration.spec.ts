import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
interface Pending { id: string; permissionKey: string; projectId: string | null }

describeIntegration('gated admin writes', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let seq = 0;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rootAuth = () => auth(world.tokens.root);
  const target = async () => data<{ id: string }>(await request(server()).post('/api/admin/users').set(rootAuth())
    .send({ email: `gate-target-${++seq}@koda.test`, name: 'Target', password: TEST_PASSWORD }).expect(201));
  const disable = (id: string, token = agent.apiKey) => request(server()).patch(`/api/admin/users/${id}`).set(auth(token)).send({ disabled: true });
  const approve = async (id: string) => data<{ status: string }>(await request(server()).post(`/api/approvals/${id}/decisions`).set(rootAuth()).send({ decision: 'approve' }).expect(200));
  const dead = () => db.outboxEvent.create({ data: { type: 'ticket_event', eventId: `dead-${++seq}`, projectId: world.projectId, status: 'dead' } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['user.update', 'outbox.retry'], null);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });
  afterAll(async () => { await app?.close(); });

  it('AC-1: user disable waits globally for an agent', async () => {
    const user = await target();
    await seedWaitPolicy(db, 'user.update', null);
    const res = await disable(user.id).expect(202);
    expect(data<Pending>(res)).toMatchObject({ permissionKey: 'user.update', projectId: null });
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).disabled).toBe(false);
  });
  it('AC-2: approved user disable executes', async () => {
    const user = await target();
    await seedWaitPolicy(db, 'user.update', null);
    const pending = data<Pending>(await disable(user.id).expect(202));
    expect(await approve(pending.id)).toMatchObject({ status: 'executed' });
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).disabled).toBe(true);
  });
  it('AC-3: approved last-admin disable fails without disabling root', async () => {
    await seedWaitPolicy(db, 'user.update', null);
    const pending = data<Pending>(await disable(world.ids.root).expect(202));
    expect(await approve(pending.id)).toMatchObject({ status: 'failed' });
    expect((await db.user.findUniqueOrThrow({ where: { id: world.ids.root } })).disabled).toBe(false);
  });
  it('AC-4: a missing key is refused without an approval row', async () => {
    const user = await target();
    const limited = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: limited.id }, ['project.read'], null);
    await app.get(PermissionCache).invalidate();
    await seedWaitPolicy(db, 'user.update', null);
    const res = await disable(user.id, limited.apiKey).expect(403);
    // The HTTP filter renders the exception key as its translated sentence.
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe('You do not have permissions to perform this action');
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('AC-5: root retries immediately despite a wait policy', async () => {
    const event = await dead();
    await seedWaitPolicy(db, 'outbox.retry', null);
    const res = await request(server()).post(`/api/admin/outbox/${event.id}/retry`).set(rootAuth()).expect(200);
    expect(res.text).toBe('');
    expect((await db.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe('pending');
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('AC-6: outbox remains JWT-only even for an agent holding its key', async () => {
    const event = await dead();
    await seedWaitPolicy(db, 'outbox.retry', null);
    await request(server()).post(`/api/admin/outbox/${event.id}/retry`).set(auth(agent.apiKey)).expect(401);
    expect((await db.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe('dead');
    expect(await db.approvalRequest.count()).toBe(0);
  });
});

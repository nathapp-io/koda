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
interface Pending { id: string; permissionKey: string; projectId: string | null }
interface Settled { status: string; result: unknown }

describeIntegration('gated global agent update routes', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let actor: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rootAuth = () => auth(world.tokens.root);
  const newTarget = async () => seedFleetHttpAgent(server(), world.tokens.root);
  const pending = (res: request.Response) => { expect(res.status).toBe(202); return data<Pending>(res); };
  const approve = async (id: string) => data<Settled>(await request(server()).post(`/api/approvals/${id}/decisions`).set(rootAuth()).send({ decision: 'approve' }).expect(200));
  const update = (slug: string, token = actor.apiKey) => request(server()).patch(`/api/agents/${slug}`).set(auth(token)).send({ name: 'renamed' });
  const capabilities = (slug: string) => request(server()).patch(`/api/agents/${slug}/update-capabilities`).set(auth(actor.apiKey)).send({ capabilities: ['ts'] });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    actor = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: actor.id }, ['agent.update', 'agent.capabilities.update'], null);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });
  afterAll(async () => { await app?.close(); });

  it('AC-1: update waits globally with the correct pending summary', async () => {
    const target = await newTarget();
    await seedWaitPolicy(db, 'agent.update', null);
    expect(pending(await update(target.slug))).toMatchObject({ permissionKey: 'agent.update', projectId: null });
  });
  it('AC-2: approval executes update', async () => {
    const target = await newTarget();
    await seedWaitPolicy(db, 'agent.update', null);
    const summary = pending(await update(target.slug));
    expect(await approve(summary.id)).toMatchObject({ status: 'executed' });
    expect((await db.agent.findUniqueOrThrow({ where: { id: target.id } })).name).toBe('renamed');
  });
  it('AC-3: capabilities update waits globally', async () => {
    const target = await newTarget();
    await seedWaitPolicy(db, 'agent.capabilities.update', null);
    expect(pending(await capabilities(target.slug))).toMatchObject({ permissionKey: 'agent.capabilities.update', projectId: null });
  });
  it('AC-4: approval executes capabilities update', async () => {
    const target = await newTarget();
    await seedWaitPolicy(db, 'agent.capabilities.update', null);
    const summary = pending(await capabilities(target.slug));
    expect(await approve(summary.id)).toMatchObject({ status: 'executed' });
    const rows = await db.agentCapabilityEntry.findMany({ where: { agentId: target.id } });
    expect(rows.map((row) => row.capability)).toEqual(['ts']);
  });
  it('AC-5: capabilities approval fails if target is deleted while waiting', async () => {
    const target = await newTarget();
    await seedWaitPolicy(db, 'agent.capabilities.update', null);
    const summary = pending(await capabilities(target.slug));
    await request(server()).delete(`/api/agents/${target.slug}`).set(rootAuth()).expect(200);
    expect(await approve(summary.id)).toMatchObject({ status: 'failed' });
  });
  it('AC-6: root update bypasses the global wait policy', async () => {
    const target = await newTarget();
    await seedWaitPolicy(db, 'agent.update', null);
    await update(target.slug, world.tokens.root).expect(200);
    expect(await db.approvalRequest.count()).toBe(0);
    expect((await db.agent.findUniqueOrThrow({ where: { id: target.id } })).name).toBe('renamed');
  });
});

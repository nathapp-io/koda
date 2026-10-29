import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { FLEET_CFG, type IFleetConfig } from '../../../src/config/fleet.config';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { FLEET_CAPS, seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
interface Pending { id: string; permissionKey: string; projectId: string }

describeIntegration('gated project thread routes', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let keyed: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let ownOnly: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let reader: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let n = 0;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const path = '/api/projects/web/threads';
  const body = () => ({ kind: 'REPO', repoId: world.repoId, feature: `gate-thread-${++n}`, title: `Thread ${n}`, backend: { kind: 'native', model: 'm1' } });
  const make = async () => data<{ id: string }>(await request(server()).post(path).set(auth(world.tokens.dev)).send(body()).expect(201));
  const pending = (res: request.Response, key: string): Pending => {
    expect(res.status).toBe(202);
    const result = data<Pending>(res);
    expect(result).toMatchObject({ permissionKey: key, projectId: world.projectId });
    return result;
  };
  const approve = async (id: string) => data<{ status: string }>(await request(server()).post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200));
  const reload = (id: string) => db.chatThread.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    app.get<IFleetConfig>(FLEET_CFG).threadsEnabled = true;
    keyed = await seedFleetHttpAgent(server(), world.tokens.root);
    ownOnly = await seedFleetHttpAgent(server(), world.tokens.root);
    reader = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: keyed.id }, ['project.read', 'thread.create', 'thread.cap.update', 'thread.archive'], world.projectId);
    await grantKeys(db, { type: 'AGENT', id: ownOnly.id }, ['project.read', 'thread.cap.update.own'], world.projectId);
    await grantKeys(db, { type: 'AGENT', id: reader.id }, ['project.read'], world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });

  it('AC-1/AC-2: create waits without a write; approval creates exactly one agent-owned thread', async () => {
    await seedWaitPolicy(db, 'thread.create', world.projectId);
    const thread = body();
    const ask = pending(await request(server()).post(path).set(auth(keyed.apiKey)).send(thread), 'thread.create');
    expect(await db.chatThread.count({ where: { feature: thread.feature } })).toBe(0);
    expect((await approve(ask.id)).status).toBe('executed');
    const rows = await db.chatThread.findMany({ where: { feature: thread.feature } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ createdById: keyed.id, createdByType: 'AGENT' });
  });

  it('AC-3: cap update waits then updates another creator thread', async () => {
    const row = await make();
    await seedWaitPolicy(db, 'thread.cap.update', world.projectId);
    const ask = pending(await request(server()).patch(`${path}/${row.id}`).set(auth(keyed.apiKey)).send({ maxCostUsd: 7 }), 'thread.cap.update');
    expect(String((await reload(row.id)).maxCostUsd)).toBe('5');
    expect((await approve(ask.id)).status).toBe('executed');
    expect(String((await reload(row.id)).maxCostUsd)).toBe('7');
  });

  it('AC-4: own-only cap update fails after approval without changing the cap', async () => {
    const row = await make();
    await seedWaitPolicy(db, 'thread.cap.update', world.projectId);
    const ask = pending(await request(server()).patch(`${path}/${row.id}`).set(auth(ownOnly.apiKey)).send({ maxCostUsd: 7 }), 'thread.cap.update');
    expect((await approve(ask.id)).status).toBe('failed');
    expect(String((await reload(row.id)).maxCostUsd)).toBe('5');
  });

  it('AC-5: archive waits then stores the archived thread detail', async () => {
    const row = await make();
    await seedWaitPolicy(db, 'thread.archive', world.projectId);
    const ask = pending(await request(server()).post(`${path}/${row.id}/archive`).set(auth(keyed.apiKey)), 'thread.archive');
    expect((await reload(row.id)).status).toBe('ACTIVE');
    expect((await approve(ask.id)).status).toBe('executed');
    expect((await reload(row.id)).status).toBe('ARCHIVED');
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: ask.id } })).result).toMatchObject({ status: 'ARCHIVED' });
  });

  it('AC-6: archive commits before cancelling the live job exactly once', async () => {
    const row = await make();
    const runner = await db.runner.create({ data: {
      name: `gate-runner-${++n}`, apiKeyHash: `gate-hash-${n}`, os: 'linux', arch: 'x64', labels: [], capacity: 2,
      capabilities: { ...FLEET_CAPS, threadWrite: true }, daemonVersion: '0.1.0', protocolVersion: 4, bootId: `boot-${n}`,
      enabled: true, lastSeenAt: new Date(), createdById: world.ids.root,
    } });
    await db.chatThread.update({ where: { id: row.id }, data: { runnerId: runner.id } });
    const job = await db.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'THREAD', feature: `thread-${row.id}`, profiles: [],
      maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, requestedByType: 'USER', threadId: row.id,
      runnerId: runner.id, state: 'RUNNING', leaseEpoch: 7,
    } });
    await db.fleetThreadTurn.create({ data: { jobId: job.id, threadId: row.id, action: 'SESSION', instructions: '', backend: { kind: 'native', model: 'm1' }, skills: [], resume: false } });
    await seedWaitPolicy(db, 'thread.archive', world.projectId);
    const ask = pending(await request(server()).post(`${path}/${row.id}/archive`).set(auth(keyed.apiKey)), 'thread.archive');
    expect((await approve(ask.id)).status).toBe('executed');
    expect((await reload(row.id)).status).toBe('ARCHIVED');
    expect((await db.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).cancelRequestedAt).not.toBeNull();
    expect(await db.fleetCommand.count({ where: { jobId: job.id, type: 'CANCEL' } })).toBe(1);
  });

  it('AC-7: human with wait policy and agent without policy create immediately without requests', async () => {
    await seedWaitPolicy(db, 'thread.create', world.projectId);
    await request(server()).post(path).set(auth(world.tokens.dev)).send(body()).expect(201);
    expect(await db.approvalRequest.count()).toBe(0);
    await db.approvalPolicy.deleteMany();
    await request(server()).post(path).set(auth(keyed.apiKey)).send(body()).expect(201);
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('AC-8: missing create key is forbidden before opening any request', async () => {
    await seedWaitPolicy(db, 'thread.create', world.projectId);
    const res = await request(server()).post(path).set(auth(reader.apiKey)).send(body()).expect(403);
    expect(res.body.ret).toBe(40003);
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('AC-13: losing a pending create feature race settles failed without a duplicate', async () => {
    await seedWaitPolicy(db, 'thread.create', world.projectId);
    const thread = body();
    const ask = pending(await request(server()).post(path).set(auth(keyed.apiKey)).send(thread), 'thread.create');
    await request(server()).post(path).set(auth(world.tokens.dev)).send(thread).expect(201);
    expect((await approve(ask.id)).status).toBe('failed');
    expect(await db.chatThread.count({ where: { repoId: world.repoId, feature: thread.feature } })).toBe(1);
  });
});

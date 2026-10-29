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

describeIntegration('gated project thread publish and discard routes', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let n = 0;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const path = '/api/projects/web/threads';
  const pending = (res: request.Response, key: string): Pending => {
    expect(res.status).toBe(202);
    const result = data<Pending>(res);
    expect(result).toMatchObject({ permissionKey: key, projectId: world.projectId });
    return result;
  };
  const approve = async (id: string) => data<{ status: string }>(await request(server()).post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200));
  const thread = async () => {
    const runner = await db.runner.create({ data: {
      name: `gated-thread-runner-${++n}`, apiKeyHash: `gated-thread-hash-${n}`, os: 'linux', arch: 'x64', labels: [], capacity: 2,
      capabilities: { ...FLEET_CAPS, threadWrite: true }, daemonVersion: '0.1.0', protocolVersion: 4, bootId: `gated-thread-boot-${n}`,
      enabled: true, lastSeenAt: new Date(), createdById: world.ids.root,
    } });
    return db.chatThread.create({ data: {
      projectId: world.projectId, repoId: world.repoId, baseRef: 'main', feature: `gated-thread-${n}`,
      title: `Gated thread ${n}`, createdById: agent.id, createdByType: 'AGENT', runnerId: runner.id,
      backend: { kind: 'native', model: 'm1' }, skills: [], specPath: '.nax/features/thread/spec.md',
      writtenPaths: ['README.md'],
    } });
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    app.get<IFleetConfig>(FLEET_CFG).threadsEnabled = true;
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'thread.publish', 'thread.discard'], world.projectId);
    await grantKeys(db, { type: 'USER', id: world.ids.root }, ['project.read', 'thread.publish', 'thread.discard'], world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });

  it('AC-1/AC-2: discard waits without a job and approval creates one DISCARD job', async () => {
    const row = await thread();
    await seedWaitPolicy(db, 'thread.discard', world.projectId);
    const ask = pending(await request(server()).post(`${path}/${row.id}/discard`).set(auth(agent.apiKey)).send({}).expect(202), 'thread.discard');
    expect(await db.fleetJob.count({ where: { threadId: row.id, command: 'THREAD' } })).toBe(0);
    expect((await approve(ask.id)).status).toBe('executed');
    const job = await db.fleetJob.findFirstOrThrow({ where: { threadId: row.id, command: 'THREAD' }, include: { threadTurn: true } });
    expect(job.threadTurn?.action).toBe('DISCARD');
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: ask.id } })).result).toMatchObject({ jobId: job.id });
  });

  it('AC-3: approved discard fails if its pinned runner went offline while waiting', async () => {
    const row = await thread();
    await seedWaitPolicy(db, 'thread.discard', world.projectId);
    const ask = pending(await request(server()).post(`${path}/${row.id}/discard`).set(auth(agent.apiKey)).send({}).expect(202), 'thread.discard');
    const runnerId = row.runnerId;
    if (!runnerId) throw new Error('Expected a pinned runner');
    await db.runner.update({ where: { id: runnerId }, data: { lastSeenAt: new Date(Date.now() - 60 * 60 * 1000) } });
    expect((await approve(ask.id)).status).toBe('failed');
    expect(await db.fleetJob.count({ where: { threadId: row.id, command: 'THREAD' } })).toBe(0);
  });

  it('FM-1: approved publish fails when its pinned runner goes offline while waiting', async () => {
    const row = await thread();
    await seedWaitPolicy(db, 'thread.publish', world.projectId);
    const ask = pending(await request(server()).post(`${path}/${row.id}/publish`).set(auth(agent.apiKey)).send({}).expect(202), 'thread.publish');
    const runnerId = row.runnerId;
    if (!runnerId) throw new Error('Expected a pinned runner');
    await db.runner.update({ where: { id: runnerId }, data: { lastSeenAt: new Date(Date.now() - 60 * 60 * 1000) } });
    expect((await approve(ask.id)).status).toBe('failed');
    expect(await db.fleetJob.count({ where: { threadId: row.id, command: 'THREAD' } })).toBe(0);
  });

  it('AC-4: publish waits and root discard executes immediately without an approval row', async () => {
    const publishThread = await thread();
    await seedWaitPolicy(db, 'thread.publish', world.projectId);
    const ask = pending(await request(server()).post(`${path}/${publishThread.id}/publish`).set(auth(agent.apiKey)).send({}).expect(202), 'thread.publish');
    expect(await db.fleetJob.count({ where: { threadId: publishThread.id } })).toBe(0);
    expect((await approve(ask.id)).status).toBe('executed');
    expect(await db.fleetJob.count({ where: { threadId: publishThread.id, command: 'THREAD', threadTurn: { action: 'PUBLISH' } } })).toBe(1);

    await db.approvalRequest.deleteMany();
    const discardThread = await thread();
    await seedWaitPolicy(db, 'thread.discard', world.projectId);
    await request(server()).post(`${path}/${discardThread.id}/discard`).set(auth(world.tokens.root)).send({}).expect(200);
    expect(await db.approvalRequest.count()).toBe(0);
    expect(await db.fleetJob.count({ where: { threadId: discardThread.id, command: 'THREAD', threadTurn: { action: 'DISCARD' } } })).toBe(1);
  });
});

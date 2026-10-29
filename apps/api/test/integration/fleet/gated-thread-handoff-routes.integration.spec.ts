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

describeIntegration('gated project thread handoff routes', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let n = 0;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const path = '/api/projects/web/threads';
  const createThread = async () => data<{ id: string }>(await request(server()).post(path).set(auth(world.tokens.dev)).send({
    kind: 'REPO', repoId: world.repoId, feature: `handoff-${++n}`, title: `Handoff ${n}`, backend: { kind: 'native', model: 'm1' },
  }).expect(201));
  const prepare = async (threadId: string) => {
    const runner = await db.runner.create({ data: {
      name: `handoff-runner-${++n}`, apiKeyHash: `handoff-hash-${n}`, os: 'linux', arch: 'x64', labels: [], capacity: 2,
      capabilities: { ...FLEET_CAPS, threadWrite: true }, daemonVersion: '0.1.0', protocolVersion: 4, bootId: `boot-${n}`,
      enabled: true, lastSeenAt: new Date(), createdById: world.ids.root,
    } });
    await db.chatThread.update({ where: { id: threadId }, data: { runnerId: runner.id, specPublished: true } });
    return runner;
  };
  const pending = (res: request.Response, key: string): Pending => {
    expect(res.status).toBe(202);
    const row = data<Pending>(res);
    expect(row).toMatchObject({ permissionKey: key, projectId: world.projectId });
    return row;
  };
  const approve = async (id: string) => data<{ status: string; result?: { job?: { id: string } } }>(
    await request(server()).post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200),
  );

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    app.get<IFleetConfig>(FLEET_CFG).threadsEnabled = true;
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'thread.plan', 'thread.run', 'fleet.job.dispatch'], world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });

  it('AC-1/AC-2: plan waits then dispatches one job on approval', async () => {
    const thread = await createThread();
    await prepare(thread.id);
    await seedWaitPolicy(db, 'thread.plan', world.projectId);
    const ask = pending(await request(server()).post(`${path}/${thread.id}/plan`).set(auth(agent.apiKey)).send({}), 'thread.plan');
    expect(await db.fleetJob.count({ where: { threadId: thread.id, command: 'PLAN' } })).toBe(0);
    expect(await approve(ask.id)).toMatchObject({ status: 'executed' });
    const jobs = await db.fleetJob.findMany({ where: { threadId: thread.id, command: 'PLAN' } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ requestedById: agent.id });
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: ask.id } })).result).toMatchObject({ job: { id: jobs[0]?.id } });
  });

  it('AC-3: stale unpublished spec fails execution after approval without a PLAN job', async () => {
    const thread = await createThread();
    await prepare(thread.id);
    await seedWaitPolicy(db, 'thread.plan', world.projectId);
    const ask = pending(await request(server()).post(`${path}/${thread.id}/plan`).set(auth(agent.apiKey)).send({}), 'thread.plan');
    await db.chatThread.update({ where: { id: thread.id }, data: { specPublished: false } });
    expect((await approve(ask.id)).status).toBe('failed');
    expect(await db.fleetJob.count({ where: { threadId: thread.id, command: 'PLAN' } })).toBe(0);
  });

  it('AC-4/AC-5: run waits for its key and approval creates one RUN job', async () => {
    const thread = await createThread();
    await prepare(thread.id);
    await db.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'PLAN', feature: `thread-${thread.id}`,
      planFrom: `.nax/features/${thread.id}/spec.md`, profiles: [], maxCostUsd: 5, selectorLabels: [],
      requestedById: agent.id, requestedByType: 'AGENT', threadId: thread.id, state: 'COMPLETED',
    } });
    await seedWaitPolicy(db, 'thread.run', world.projectId);
    const ask = pending(await request(server()).post(`${path}/${thread.id}/run`).set(auth(agent.apiKey)).send({}), 'thread.run');
    expect((await approve(ask.id)).status).toBe('executed');
    expect(await db.fleetJob.count({ where: { threadId: thread.id, command: 'RUN' } })).toBe(1);
  });

  it.each(['plan', 'run'] as const)('B1: approved %s fails after only dispatch permission is revoked', async (action) => {
    const requester = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: requester.id }, ['project.read', `thread.${action}`], world.projectId);
    const dispatch = await grantKeys(db, { type: 'AGENT', id: requester.id }, ['fleet.job.dispatch'], world.projectId);
    await app.get(PermissionCache).invalidate();
    const thread = await createThread();
    await prepare(thread.id);
    if (action === 'run') {
      await db.fleetJob.create({ data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'PLAN', feature: `thread-${thread.id}`,
        planFrom: `.nax/features/${thread.id}/spec.md`, profiles: [], maxCostUsd: 5, selectorLabels: [],
        requestedById: requester.id, requestedByType: 'AGENT', threadId: thread.id, state: 'COMPLETED',
      } });
    }
    await seedWaitPolicy(db, `thread.${action}`, world.projectId);
    const ask = pending(await request(server()).post(`${path}/${thread.id}/${action}`).set(auth(requester.apiKey)).send({}), `thread.${action}`);
    await db.roleBinding.delete({ where: { id: dispatch.id } });
    await app.get(PermissionCache).invalidate();
    expect((await approve(ask.id)).status).toBe('failed');
    expect(await db.fleetJob.count({ where: { threadId: thread.id, command: action === 'plan' ? 'PLAN' : 'RUN' } })).toBe(0);
  });

  it('AC-6: fleet.job.dispatch policy does not gate a plan under thread.plan', async () => {
    const thread = await createThread();
    await prepare(thread.id);
    await seedWaitPolicy(db, 'fleet.job.dispatch', world.projectId);
    await request(server()).post(`${path}/${thread.id}/plan`).set(auth(agent.apiKey)).send({}).expect(201);
    expect(await db.approvalRequest.count()).toBe(0);
  });
});

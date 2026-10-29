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

describeIntegration('gated project thread session routes', () => {
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
  const session = async (pendingQuestion?: { requestId: string }) => {
    const created = data<{ id: string }>(await request(server()).post(path).set(auth(agent.apiKey)).send({
      kind: 'REPO', repoId: world.repoId, feature: `session-${++n}`, title: `Session ${n}`, backend: { kind: 'native', model: 'm1' },
    }).expect(201));
    const runner = await db.runner.create({ data: {
      name: `session-runner-${n}`, apiKeyHash: `session-hash-${n}`, os: 'linux', arch: 'x64', labels: [], capacity: 2,
      capabilities: { ...FLEET_CAPS, threadWrite: true }, daemonVersion: '0.1.0', protocolVersion: 4, bootId: `boot-${n}`,
      enabled: true, lastSeenAt: new Date(), createdById: world.ids.root,
    } });
    await db.chatThread.update({ where: { id: created.id }, data: { runnerId: runner.id, ...(pendingQuestion ? { pendingQuestion } : {}) } });
    const job = await db.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'THREAD', feature: `thread-${created.id}`, profiles: [],
      maxCostUsd: 5, selectorLabels: [], requestedById: agent.id, requestedByType: 'AGENT', threadId: created.id,
      runnerId: runner.id, state: 'RUNNING', leaseEpoch: 3,
    } });
    await db.fleetThreadTurn.create({ data: {
      jobId: job.id, threadId: created.id, action: 'SESSION', initialMessageId: null, instructions: '',
      backend: { kind: 'native', model: 'm1' }, skills: [], resume: false,
    } });
    return { threadId: created.id, jobId: job.id };
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    app.get<IFleetConfig>(FLEET_CFG).threadsEnabled = true;
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'thread.create', 'thread.stop', 'thread.end-session', 'thread.answer'], world.projectId);
    await grantKeys(db, { type: 'USER', id: world.ids.root }, ['project.read', 'thread.stop'], world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });

  it('AC-1/AC-2: stop waits without a command and approval queues one stop turn command', async () => {
    const { threadId, jobId } = await session();
    await seedWaitPolicy(db, 'thread.stop', world.projectId);
    const ask = pending(await request(server()).post(`${path}/${threadId}/stop`).set(auth(agent.apiKey)).expect(202), 'thread.stop');
    expect(await db.fleetCommand.count({ where: { jobId, type: 'THREAD_STOP_TURN' } })).toBe(0);
    expect((await approve(ask.id)).status).toBe('executed');
    expect(await db.fleetCommand.count({ where: { jobId, type: 'THREAD_STOP_TURN' } })).toBe(1);
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: ask.id } })).result).toEqual({});
  });

  it('AC-3: approved end-session queues one close command', async () => {
    const { threadId, jobId } = await session();
    await seedWaitPolicy(db, 'thread.end-session', world.projectId);
    const ask = pending(await request(server()).post(`${path}/${threadId}/end-session`).set(auth(agent.apiKey)).expect(202), 'thread.end-session');
    expect((await approve(ask.id)).status).toBe('executed');
    expect(await db.fleetCommand.count({ where: { jobId, type: 'THREAD_CLOSE' } })).toBe(1);
  });

  it('AC-4: approved answer queues the requested question response', async () => {
    const { threadId, jobId } = await session({ requestId: 'q1' });
    await seedWaitPolicy(db, 'thread.answer', world.projectId);
    const ask = pending(await request(server()).post(`${path}/${threadId}/answer`).set(auth(agent.apiKey)).send({ requestId: 'q1', text: 'yes' }).expect(202), 'thread.answer');
    expect((await approve(ask.id)).status).toBe('executed');
    expect(await db.fleetCommand.findFirst({ where: { jobId, type: 'THREAD_ANSWER' } })).toMatchObject({ payload: { requestId: 'q1', text: 'yes' } });
  });

  it('AC-5: stop fails at execution if its waiting session completes', async () => {
    const { threadId, jobId } = await session();
    await seedWaitPolicy(db, 'thread.stop', world.projectId);
    const ask = pending(await request(server()).post(`${path}/${threadId}/stop`).set(auth(agent.apiKey)).expect(202), 'thread.stop');
    await db.fleetJob.update({ where: { id: jobId }, data: { state: 'COMPLETED' } });
    expect((await approve(ask.id)).status).toBe('failed');
    expect(await db.fleetCommand.count({ where: { jobId, type: 'THREAD_STOP_TURN' } })).toBe(0);
  });

  it('AC-6: root with a wait policy stops immediately without an approval request', async () => {
    const { threadId, jobId } = await session();
    await seedWaitPolicy(db, 'thread.stop', world.projectId);
    await request(server()).post(`${path}/${threadId}/stop`).set(auth(world.tokens.root)).expect(200).expect((res) => {
      expect(data(res)).toEqual({});
    });
    expect(await db.approvalRequest.count()).toBe(0);
    expect(await db.fleetCommand.count({ where: { jobId, type: 'THREAD_STOP_TURN' } })).toBe(1);
  });
});

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

describeIntegration('gated workspace thread session routes (US-007)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let n = 0;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const pending = (res: request.Response, key: string): Pending => {
    expect(res.status).toBe(202);
    const result = data<Pending>(res);
    expect(result).toMatchObject({ permissionKey: key, projectId: world.projectId });
    return result;
  };
  const approve = async (id: string) => data<{ status: string }>(await request(server()).post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200));
  const ownThread = async (createdById = agent.id, pendingQuestion?: { requestId: string }) => db.chatThread.create({ data: {
    kind: 'WORKSPACE', projectId: world.projectId, repoId: null, baseRef: null, feature: null,
    title: `US007-${++n}`, createdById, createdByType: createdById === agent.id ? 'AGENT' : 'USER',
    backend: { kind: 'native', model: 'm1' }, skills: [], ...(pendingQuestion ? { pendingQuestion } : {}),
  } });
  const liveSession = async (pendingQuestion?: { requestId: string }) => {
    const thread = await ownThread(agent.id, pendingQuestion);
    const runner = await db.runner.create({ data: {
      name: `us007-runner-${n}`, apiKeyHash: `us007-hash-${n}`, os: 'linux', arch: 'x64', labels: [], capacity: 2,
      capabilities: { ...FLEET_CAPS, threadWrite: true }, daemonVersion: '0.1.0', protocolVersion: 4, bootId: `us007-boot-${n}`,
      enabled: true, lastSeenAt: new Date(), createdById: world.ids.root,
    } });
    await db.chatThread.update({ where: { id: thread.id }, data: { runnerId: runner.id } });
    const job = await db.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'THREAD', feature: `thread-${thread.id}`, profiles: [],
      maxCostUsd: 5, selectorLabels: [], requestedById: agent.id, requestedByType: 'AGENT', threadId: thread.id,
      runnerId: runner.id, state: 'RUNNING', leaseEpoch: 1,
    } });
    await db.fleetThreadTurn.create({ data: {
      jobId: job.id, threadId: thread.id, action: 'SESSION', initialMessageId: null, instructions: '',
      backend: { kind: 'native', model: 'm1' }, skills: [], resume: false,
    } });
    return { thread, job };
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    app.get<IFleetConfig>(FLEET_CFG).threadsEnabled = true;
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'thread.cap.update', 'thread.stop', 'thread.end-session', 'thread.answer'], world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });

  it('AC-1/2: cap update waits in home project then applies after approval', async () => {
    const thread = await ownThread();
    await seedWaitPolicy(db, 'thread.cap.update', world.projectId);
    const ask = pending(await request(server()).patch(`/api/threads/${thread.id}`).set(auth(agent.apiKey)).send({ maxCostUsd: 7 }), 'thread.cap.update');
    expect(String((await db.chatThread.findUniqueOrThrow({ where: { id: thread.id } })).maxCostUsd)).toBe('5');
    expect((await approve(ask.id)).status).toBe('executed');
    expect(String((await db.chatThread.findUniqueOrThrow({ where: { id: thread.id } })).maxCostUsd)).toBe('7');
  });

  it('AC-3: approved stop queues one THREAD_STOP_TURN for the live session', async () => {
    const { thread, job } = await liveSession();
    await seedWaitPolicy(db, 'thread.stop', world.projectId);
    const ask = pending(await request(server()).post(`/api/threads/${thread.id}/stop`).set(auth(agent.apiKey)), 'thread.stop');
    expect(await db.fleetCommand.count({ where: { jobId: job.id, type: 'THREAD_STOP_TURN' } })).toBe(0);
    expect((await approve(ask.id)).status).toBe('executed');
    expect(await db.fleetCommand.count({ where: { jobId: job.id, type: 'THREAD_STOP_TURN' } })).toBe(1);
  });

  it('AC-4: approved answer queues one THREAD_ANSWER for the live session', async () => {
    const { thread, job } = await liveSession({ requestId: 'q1' });
    await seedWaitPolicy(db, 'thread.answer', world.projectId);
    const ask = pending(await request(server()).post(`/api/threads/${thread.id}/answer`).set(auth(agent.apiKey)).send({ requestId: 'q1', text: 'yes' }), 'thread.answer');
    expect((await approve(ask.id)).status).toBe('executed');
    expect(await db.fleetCommand.count({ where: { jobId: job.id, type: 'THREAD_ANSWER' } })).toBe(1);
  });

  it('AC-5: stop against another owner returns 404 before opening a request', async () => {
    const thread = await ownThread(world.ids.dev);
    await seedWaitPolicy(db, 'thread.stop', world.projectId);
    const res = await request(server()).post(`/api/threads/${thread.id}/stop`).set(auth(agent.apiKey)).expect(404);
    expect(res.body.message).toBe('Thread not found');
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('AC-6: revoked stop permission fails approved execution without queuing a command', async () => {
    const { thread, job } = await liveSession();
    await seedWaitPolicy(db, 'thread.stop', world.projectId);
    const ask = pending(await request(server()).post(`/api/threads/${thread.id}/stop`).set(auth(agent.apiKey)), 'thread.stop');
    await db.roleBinding.deleteMany({ where: { principalType: 'AGENT', principalId: agent.id, projectId: world.projectId } });
    await app.get(PermissionCache).invalidate();
    expect(await approve(ask.id)).toMatchObject({
      status: 'failed', result: { error: 'execution-failed', name: 'ForbiddenAppException' },
    });
    expect(await db.fleetCommand.count({ where: { jobId: job.id, type: 'THREAD_STOP_TURN' } })).toBe(0);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'thread.cap.update', 'thread.stop', 'thread.end-session', 'thread.answer'], world.projectId);
    await app.get(PermissionCache).invalidate();
  });

  it('AC-9: malformed cap body against another owner returns 404 before body validation', async () => {
    const thread = await ownThread(world.ids.dev);
    await seedWaitPolicy(db, 'thread.cap.update', world.projectId);
    const res = await request(server()).patch(`/api/threads/${thread.id}`).set(auth(agent.apiKey)).send({}).expect(404);
    expect(res.body.message).toBe('Thread not found');
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('AC-10/11: malformed own-thread cap and answer are immediate 400 or wait then fail on approval', async () => {
    for (const [key, method] of [['thread.cap.update', 'patch'], ['thread.answer', 'post']] as const) {
      const thread = await ownThread();
      const url = method === 'patch' ? `/api/threads/${thread.id}` : `/api/threads/${thread.id}/answer`;
      const send = () => request(server())[method](url).set(auth(agent.apiKey)).send({});
      const requestsBefore = await db.approvalRequest.count();
      await send().expect(400);
      expect(await db.approvalRequest.count()).toBe(requestsBefore);
      await seedWaitPolicy(db, key, world.projectId);
      const ask = pending(await send(), key);
      expect((await approve(ask.id)).status).toBe('failed');
      expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: ask.id } })).result).toMatchObject({ error: 'execution-failed' });
    }
  }, 30_000);
});

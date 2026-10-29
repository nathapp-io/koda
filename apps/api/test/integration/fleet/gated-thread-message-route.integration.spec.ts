import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { FLEET_CFG, type IFleetConfig } from '../../../src/config/fleet.config';
import { ProjectBriefService } from '../../../src/fleet/threads/project-brief.service';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { FLEET_CAPS, seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('gated project thread message route', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let context: ReturnType<typeof vi.spyOn<ProjectBriefService, 'resolveRepoContext'>>;
  let n = 0;
  let previousThreadsEnabled: boolean;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const send = (id: string, clientMessageId: string, token = agent.apiKey, text = 'hello') => request(app.getHttpServer())
    .post(`/api/projects/web/threads/${id}/messages`).set(auth(token)).send({ text, clientMessageId });
  const thread = async () => {
    const runner = await db.runner.create({ data: {
      name: `message-runner-${++n}`, apiKeyHash: `message-hash-${n}`, os: 'linux', arch: 'x64', labels: [], capacity: 2,
      capabilities: { ...FLEET_CAPS, threadWrite: true }, daemonVersion: '0.1.0', protocolVersion: 4, bootId: `message-boot-${n}`,
      enabled: true, lastSeenAt: new Date(), createdById: world.ids.root,
    } });
    return db.chatThread.create({ data: {
      kind: 'REPO', projectId: world.projectId, repoId: world.repoId, baseRef: 'main', feature: `message-gate-${n}`, runnerId: runner.id,
      specPath: `.nax/features/message-gate-${n}/spec.md`, title: 'Message gate', createdById: agent.id, createdByType: 'AGENT', backend: { kind: 'native', model: 'm1' }, skills: [],
    } });
  };
  const waiting = async (text = 'hello') => {
    const row = await thread();
    const clientMessageId = `message-${n}`;
    await seedWaitPolicy(db, 'thread.message.send', world.projectId);
    const response = await send(row.id, clientMessageId, agent.apiKey, text).expect(202);
    const ask = data<{ id: string; permissionKey: string; projectId: string }>(response);
    expect(ask).toMatchObject({ permissionKey: 'thread.message.send', projectId: world.projectId });
    return { row, clientMessageId, ask };
  };
  const count = (clientMessageId: string) => db.chatMessage.count({ where: { clientMessageId } });
  const approve = async (id: string) => {
    await request(app.getHttpServer()).post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200);
    return db.approvalRequest.findUniqueOrThrow({ where: { id } });
  };
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
    previousThreadsEnabled = app.get<IFleetConfig>(FLEET_CFG).threadsEnabled;
    app.get<IFleetConfig>(FLEET_CFG).threadsEnabled = true;
    agent = await seedFleetHttpAgent(app.getHttpServer(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'thread.message.send'], world.projectId);
    await grantKeys(db, { type: 'USER', id: world.ids.root }, ['project.read', 'thread.message.send'], world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  afterAll(async () => {
    if (app) {
      app.get<IFleetConfig>(FLEET_CFG).threadsEnabled = previousThreadsEnabled;
      await app.close();
    }
  });
  beforeEach(async () => {
    context = vi.spyOn(ProjectBriefService.prototype, 'resolveRepoContext').mockResolvedValue('ctx');
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });
  afterEach(() => { context.mockRestore(); });

  it('AC-1: waits without writing a message', async () => {
    const { clientMessageId } = await waiting();
    expect(await count(clientMessageId)).toBe(0);
  });
  it('AC-2: does not read repository context while waiting', async () => {
    await waiting();
    expect(context).not.toHaveBeenCalled();
  });
  it('AC-3: approval writes one user message and stores its id', async () => {
    const { ask, clientMessageId } = await waiting();
    const settled = await approve(ask.id);
    const message = await db.chatMessage.findFirstOrThrow({ where: { clientMessageId } });
    expect(settled.status).toBe('executed');
    expect(message.role).toBe('user');
    expect(settled.result).toMatchObject({ message: { id: message.id } });
    expect(await count(clientMessageId)).toBe(1);
  });
  it('AC-4: a preparation failure settles failed without a message', async () => {
    const { ask, clientMessageId } = await waiting();
    context.mockRejectedValue(new TypeError('context unavailable'));
    const settled = await approve(ask.id);
    expect(settled.status).toBe('failed');
    expect(settled.result).toMatchObject({ error: 'execution-failed', name: 'TypeError' });
    expect(await count(clientMessageId)).toBe(0);
  });
  it('AC-5: approval deduplicates a message sent while waiting', async () => {
    const { ask, row, clientMessageId } = await waiting();
    await db.approvalPolicy.deleteMany();
    const earlier = data<{ message: unknown }>(await send(row.id, clientMessageId).expect(201));
    const settled = await approve(ask.id);
    expect(settled.status).toBe('executed');
    expect(settled.result).toEqual({ message: earlier.message, jobId: null });
    expect(await count(clientMessageId)).toBe(1);
  });
  it('AC-6: humans bypass waiting and duplicate sends return 200', async () => {
    const row = await thread();
    await seedWaitPolicy(db, 'thread.message.send', world.projectId);
    await send(row.id, `human-${n}`, world.tokens.root).expect((response) => { expect(response.status, JSON.stringify(response.body)).toBe(201); });
    await send(row.id, `human-${n}`, world.tokens.root).expect(200);
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('AC-11: immediate invalid text retains threads.input 400', async () => {
    const row = await thread();
    const response = await send(row.id, `invalid-${n}`, agent.apiKey, '').expect(400);
    expect(response.body).toMatchObject({ ret: -2, message: 'Invalid thread input: message' });
    expect(context).not.toHaveBeenCalled();
  });
  it('AC-12: invalid waiting text fails during preparation without a message', async () => {
    const { ask, clientMessageId } = await waiting('');
    const settled = await approve(ask.id);
    expect(settled.status).toBe('failed');
    expect(settled.result).toMatchObject({ error: 'execution-failed' });
    expect(await count(clientMessageId)).toBe(0);
    expect(context).not.toHaveBeenCalled();
  });
});

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
interface Pending { id: string; permissionKey: string; projectId: string | null }

describeIntegration('gated workspace thread routes (US-006)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let n = 0;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const workspaceBody = () => ({ title: `US006-${++n}`, backend: { kind: 'native', model: 'm1' }, homeProject: 'web' });
  const pending = (res: request.Response, key: string): Pending => {
    expect(res.status).toBe(202);
    const result = data<Pending>(res);
    expect(result).toMatchObject({ permissionKey: key, projectId: null });
    return result;
  };
  const approve = async (id: string) => data<{ status: string }>(
    await request(server()).post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200),
  );

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    app.get<IFleetConfig>(FLEET_CFG).threadsEnabled = true;
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['thread.workspace.create', 'thread.workspace.archive'], null);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'thread.create'], world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });

  it('AC-1/AC-2: workspace create waits globally without a write; approval creates exactly one agent-owned thread', async () => {
    const body = workspaceBody();
    await seedWaitPolicy(db, 'thread.workspace.create', null);

    const ask = pending(await request(server()).post('/api/threads').set(auth(agent.apiKey)).send(body), 'thread.workspace.create');
    expect(await db.chatThread.count({ where: { title: body.title } })).toBe(0);

    expect(await approve(ask.id)).toMatchObject({ status: 'executed' });
    const rows = await db.chatThread.findMany({ where: { title: body.title } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'WORKSPACE', projectId: world.projectId, createdById: agent.id, createdByType: 'AGENT' });
  }, 30_000);

  it('AC-6: a human executes immediately despite the global agent wait policy', async () => {
    await seedWaitPolicy(db, 'thread.workspace.create', null);
    const body = workspaceBody();
    const requestsBefore = await db.approvalRequest.count();

    await request(server()).post('/api/threads').set(auth(world.tokens.dev)).send(body).expect(201);

    expect(await db.approvalRequest.count()).toBe(requestsBefore);
    expect(await db.chatThread.count({ where: { title: body.title } })).toBe(1);
  }, 30_000);

  it('AC-3: workspace archive waits globally and approval archives the owned thread', async () => {
    const body = workspaceBody();
    const created = data<{ id: string }>(await request(server()).post('/api/threads').set(auth(agent.apiKey)).send(body).expect(201));
    await seedWaitPolicy(db, 'thread.workspace.archive', null);

    const ask = pending(await request(server()).post(`/api/threads/${created.id}/archive`).set(auth(agent.apiKey)), 'thread.workspace.archive');
    expect((await db.chatThread.findUniqueOrThrow({ where: { id: created.id } })).status).toBe('ACTIVE');
    expect(await approve(ask.id)).toMatchObject({ status: 'executed' });
    expect((await db.chatThread.findUniqueOrThrow({ where: { id: created.id } })).status).toBe('ARCHIVED');
  }, 30_000);

  it('AC-4: approval of a pending archive fails when the target is not owned by the requester', async () => {
    const other = await db.chatThread.create({ data: {
      kind: 'WORKSPACE', projectId: world.projectId, repoId: null, baseRef: null, feature: null,
      title: workspaceBody().title, createdById: world.ids.dev, backend: { kind: 'native', model: 'm1' }, skills: [],
    } });
    await seedWaitPolicy(db, 'thread.workspace.archive', null);
    const ask = pending(await request(server()).post(`/api/threads/${other.id}/archive`).set(auth(agent.apiKey)), 'thread.workspace.archive');

    expect(await approve(ask.id)).toMatchObject({ status: 'failed' });
    expect((await db.chatThread.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('ACTIVE');
  }, 30_000);

  it('AC-5: approved live-job archive commits before requesting cancellation', async () => {
    const body = workspaceBody();
    const created = data<{ id: string }>(await request(server()).post('/api/threads').set(auth(agent.apiKey)).send(body).expect(201));
    const runner = await db.runner.create({ data: {
      name: `workspace-archive-runner-${++n}`, apiKeyHash: `workspace-archive-hash-${n}`, os: 'linux', arch: 'x64', labels: [],
      capacity: 2, capabilities: { ...FLEET_CAPS, threadWrite: true }, daemonVersion: '0.1.0', protocolVersion: 4,
      bootId: `workspace-archive-boot-${n}`, enabled: true, lastSeenAt: new Date(), createdById: world.ids.root,
    } });
    await db.chatThread.update({ where: { id: created.id }, data: { runnerId: runner.id } });
    const job = await db.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'THREAD', feature: `thread-${created.id}`,
      profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: agent.id, requestedByType: 'AGENT',
      threadId: created.id, runnerId: runner.id, state: 'RUNNING', leaseEpoch: 1,
    } });
    await db.fleetThreadTurn.create({ data: {
      jobId: job.id, threadId: created.id, action: 'SESSION', initialMessageId: null, instructions: '',
      backend: { kind: 'native', model: 'm1' }, skills: [], resume: false,
    } });
    await seedWaitPolicy(db, 'thread.workspace.archive', null);
    const ask = pending(await request(server()).post(`/api/threads/${created.id}/archive`).set(auth(agent.apiKey)), 'thread.workspace.archive');

    expect(await approve(ask.id)).toMatchObject({ status: 'executed' });
    expect((await db.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).cancelRequestedAt).not.toBeNull();
    expect(await db.fleetCommand.count({ where: { jobId: job.id, type: 'CANCEL' } })).toBe(1);
  }, 30_000);
});

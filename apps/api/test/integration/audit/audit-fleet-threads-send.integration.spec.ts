import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { FLEET_CFG, type IFleetConfig } from '../../../src/config/fleet.config';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { ThreadsService } from '../../../src/fleet/threads/threads.service';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';
import { FLEET_CAPS, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeDb = canRunDbTests() ? describe : describe.skip;

describeDb('fleet thread message and handoff audit HTTP', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  let config: IFleetConfig;
  let previousThreadsEnabled: boolean;
  let seq = 0;
  const auth = () => ({ Authorization: `Bearer ${world.tokens.dev}` });
  const entries = (key: string, resourceId: string) => db.auditEntry.findMany({ where: { key, resourceType: 'thread', resourceId }, take: 10 });
  const projectThread = (over: Record<string, unknown> = {}) => db.chatThread.create({ data: {
    projectId: world.projectId, repoId: world.repoId, baseRef: 'trunk', feature: `audit-send-${++seq}`,
    title: 'Audit send fixture', createdById: world.ids.dev, backend: { kind: 'native', model: 'm1' }, skills: [],
    specPath: '.nax/features/audit/spec.md', ...over,
  } });
  const runner = () => db.runner.create({ data: {
    name: `thread-send-audit-${++seq}`, apiKeyHash: `thread-send-audit-hash-${seq}`, os: 'linux', arch: 'x64', labels: [], capacity: 2,
    capabilities: { ...FLEET_CAPS, threadWrite: true }, daemonVersion: '0.1.0', protocolVersion: 4,
    bootId: `thread-send-audit-boot-${seq}`, enabled: true, lastSeenAt: new Date(), createdById: world.ids.root,
  } });
  const liveSession = async (threadId: string, runnerId: string) => {
    const job = await db.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${threadId}`,
      profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, requestedByType: 'USER', threadId,
      runnerId, state: 'RUNNING', leaseEpoch: 7,
    } });
    await db.fleetThreadTurn.create({ data: { jobId: job.id, threadId, action: 'SESSION', initialMessageId: null, instructions: '', backend: { kind: 'native', model: 'm1' }, skills: [], resume: false } });
    return job;
  };
  const send = (threadId: string, clientMessageId: string, text = 'secret-text') => request(app.getHttpServer())
    .post(`/api/projects/web/threads/${threadId}/messages`).set(auth()).send({ text, clientMessageId });
  const projectPost = (threadId: string, action: string) => request(app.getHttpServer()).post(`/api/projects/web/threads/${threadId}/${action}`).set(auth());

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
    config = app.get<IFleetConfig>(FLEET_CFG, { strict: false });
    previousThreadsEnabled = config.threadsEnabled;
    config.threadsEnabled = true;
  }, 60_000);
  beforeEach(() => resetThrottle(app));
  afterAll(async () => {
    if (config) config.threadsEnabled = previousThreadsEnabled;
    await app?.close();
  });

  it('AC-1/2: new-session send audits ids only and excludes secret text', async () => {
    const thread = await projectThread();
    const response = await send(thread.id, `client-${++seq}`).expect(201);
    const payload = data<{ message: { id: string }; jobId: string }>(response);
    const rows = await db.auditEntry.findMany({ where: { key: 'thread.message.send', resourceType: 'thread', resourceId: thread.id }, take: 10 });
    expect(rows).toEqual([expect.objectContaining({ resourceType: 'thread', resourceId: thread.id, projectId: world.projectId, summary: `message ${payload.message.id}, job ${payload.jobId}` })]);
    expect(rows[0]?.summary).not.toContain('secret-text');
  });

  it('AC-3: repeat is deduplicated internally, records no second entry and keeps HTTP response unchanged', async () => {
    const thread = await projectThread();
    const clientMessageId = `client-${++seq}`;
    await send(thread.id, clientMessageId).expect(201);
    const sendMessage = vi.spyOn(app.get(ThreadsService), 'sendMessage');
    const response = await send(thread.id, clientMessageId).expect(200);
    expect(sendMessage.mock.results.at(-1)?.value).toBeDefined();
    await expect(sendMessage.mock.results.at(-1)?.value).resolves.toMatchObject({ deduplicated: true });
    expect(Object.keys(data<Record<string, unknown>>(response)).sort()).toEqual(['jobId', 'message']);
    expect(await entries('thread.message.send', thread.id)).toHaveLength(1);
    sendMessage.mockRestore();
  });

  it('AC-4: live-session send records a message-only summary', async () => {
    const runnerRow = await runner();
    const thread = await projectThread({ runnerId: runnerRow.id });
    await liveSession(thread.id, runnerRow.id);
    const response = await send(thread.id, `client-${++seq}`).expect(201);
    const messageId = data<{ message: { id: string } }>(response).message.id;
    expect(await entries('thread.message.send', thread.id)).toEqual([expect.objectContaining({ summary: `message ${messageId}` })]);
  });

  it('AC-5: archived sends refuse without an audit entry', async () => {
    const thread = await projectThread({ status: 'ARCHIVED', archivedAt: new Date() });
    await send(thread.id, `client-${++seq}`).expect(409);
    expect(await entries('thread.message.send', thread.id)).toEqual([]);
  });

  it('AC-6: audit failure rolls back the stored message', async () => {
    const thread = await projectThread();
    const record = vi.spyOn(app.get(AuditRecorder), 'record').mockRejectedValue(new Error('audit unavailable'));
    const clientMessageId = `client-${++seq}`;
    await send(thread.id, clientMessageId).expect(500);
    expect(await db.chatMessage.findUnique({ where: { threadId_clientMessageId: { threadId: thread.id, clientMessageId } } })).toBeNull();
    record.mockRestore();
  });

  it('AC-7: workspace message uses workspace key and home project id', async () => {
    const thread = await db.chatThread.create({ data: { projectId: world.projectId, kind: 'WORKSPACE', repoId: null, baseRef: null, feature: null,
      title: `workspace-${++seq}`, createdById: world.ids.dev, backend: { kind: 'native', model: 'm1' }, skills: [] } });
    await request(app.getHttpServer()).post(`/api/threads/${thread.id}/messages`).set(auth()).send({ text: 'secret-text', clientMessageId: `client-${++seq}` }).expect(201);
    expect(await db.auditEntry.findMany({ where: { key: 'thread.workspace.message.send', resourceType: 'thread', resourceId: thread.id }, take: 10 }))
      .toEqual([expect.objectContaining({ projectId: world.projectId, resourceId: thread.id })]);
  });

  it('AC-8/9: plan dispatch is audited under thread.plan, not the generic dispatch key', async () => {
    const runnerRow = await runner();
    const thread = await projectThread({ runnerId: runnerRow.id, specPublished: true });
    const response = await projectPost(thread.id, 'plan').send({}).expect(201);
    const jobId = data<{ job: { id: string } }>(response).job.id;
    const rows = await db.auditEntry.findMany({ where: { resourceId: jobId }, take: 10 });
    expect(rows).toEqual([expect.objectContaining({ key: 'thread.plan', resourceType: 'fleet-job', projectId: world.projectId, summary: `PLAN on repo ${world.repoId}, thread ${thread.id}` })]);
    expect(rows.some((row) => row.key === 'fleet.job.dispatch')).toBe(false);
  });

  it('AC-10: run dispatch is audited under thread.run after a completed plan', async () => {
    const runnerRow = await runner();
    const thread = await projectThread({ runnerId: runnerRow.id, specPublished: true });
    await db.fleetJob.create({ data: { projectId: world.projectId, repoId: world.repoId, ref: 'feat/audit', command: 'PLAN', feature: thread.feature ?? 'audit', profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, requestedByType: 'USER', threadId: thread.id, state: 'COMPLETED' } });
    const response = await projectPost(thread.id, 'run').send({}).expect(201);
    const jobId = data<{ job: { id: string } }>(response).job.id;
    expect(await db.auditEntry.findMany({ where: { key: 'thread.run', resourceType: 'fleet-job', resourceId: jobId }, take: 10 }))
      .toEqual([expect.objectContaining({ summary: `RUN on repo ${world.repoId}, thread ${thread.id}`, projectId: world.projectId })]);
  });
});

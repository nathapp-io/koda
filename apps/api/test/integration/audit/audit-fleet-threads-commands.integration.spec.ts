import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { FLEET_CFG, type IFleetConfig } from '../../../src/config/fleet.config';
import { canRunDbTests } from '../../helpers/test-environment';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';
import { FLEET_CAPS, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';

const describeDb = canRunDbTests() ? describe : describe.skip;
describeDb('fleet thread command audit HTTP', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  let config: IFleetConfig;
  let previousThreadsEnabled: boolean;
  let seq = 0;
  const auth = () => ({ Authorization: `Bearer ${world.tokens.dev}` });
  const entries = (key: string, resourceId: string) => db.auditEntry.findMany({ where: { key, resourceType: 'thread', resourceId }, take: 10 });
  const projectThread = (over: Record<string, unknown> = {}) => db.chatThread.create({ data: {
    projectId: world.projectId, repoId: world.repoId, baseRef: 'trunk', feature: `audit-command-${++seq}`,
    title: 'Audit command fixture', createdById: world.ids.dev, backend: { kind: 'native', model: 'm1' }, skills: [],
    specPath: '.nax/features/audit/spec.md', ...over,
  } });
  const workspaceThread = (over: Record<string, unknown> = {}) => db.chatThread.create({ data: {
    projectId: world.projectId, kind: 'WORKSPACE', repoId: null, baseRef: null, feature: null,
    title: `workspace-${++seq}`, createdById: world.ids.dev, backend: { kind: 'native', model: 'm1' }, skills: [], ...over,
  } });
  const runner = () => db.runner.create({ data: {
    name: `thread-audit-${++seq}`, apiKeyHash: `thread-audit-hash-${seq}`, os: 'linux', arch: 'x64', labels: [], capacity: 2,
    capabilities: { ...FLEET_CAPS, threadWrite: true }, daemonVersion: '0.1.0', protocolVersion: 4,
    bootId: `thread-audit-boot-${seq}`, enabled: true, lastSeenAt: new Date(), createdById: world.ids.root,
  } });
  const liveSession = async (threadId: string, runnerId: string) => {
    const job = await db.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${threadId}`,
      profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, requestedByType: 'USER', threadId,
      runnerId, state: 'RUNNING', leaseEpoch: 7,
    } });
    await db.fleetThreadTurn.create({ data: {
      jobId: job.id, threadId, action: 'SESSION', initialMessageId: null, instructions: '',
      backend: { kind: 'native', model: 'm1' }, skills: [], resume: false,
    } });
    return job;
  };
  const projectPost = (threadId: string, action: string, body: Record<string, unknown> = {}) => request(app.getHttpServer())
    .post(`/api/projects/web/threads/${threadId}/${action}`).set(auth()).send(body);
  const workspacePost = (threadId: string, action: string, body: Record<string, unknown> = {}) => request(app.getHttpServer())
    .post(`/api/threads/${threadId}/${action}`).set(auth()).send(body);

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

  it('AC-1: stop on a live project session records one thread.stop entry', async () => {
    const runnerRow = await runner();
    const thread = await projectThread({ runnerId: runnerRow.id });
    await liveSession(thread.id, runnerRow.id);
    await projectPost(thread.id, 'stop').expect(200);
    expect(await entries('thread.stop', thread.id)).toEqual([expect.objectContaining({ key: 'thread.stop', resourceId: thread.id, projectId: world.projectId, summary: 'stop requested' })]);
  });

  it('AC-2: end-session on a live project session records one thread.end-session entry', async () => {
    const runnerRow = await runner();
    const thread = await projectThread({ runnerId: runnerRow.id });
    await liveSession(thread.id, runnerRow.id);
    await projectPost(thread.id, 'end-session').expect(200);
    expect(await entries('thread.end-session', thread.id)).toEqual([expect.objectContaining({ key: 'thread.end-session', resourceId: thread.id, projectId: world.projectId, summary: 'end requested' })]);
  });

  it('AC-3/4: answer records a fixed summary and never the submitted text', async () => {
    const runnerRow = await runner();
    const thread = await projectThread({ runnerId: runnerRow.id, pendingQuestion: { requestId: 'request-audit' } });
    await liveSession(thread.id, runnerRow.id);
    await projectPost(thread.id, 'answer', { requestId: 'request-audit', text: 'secret-answer' }).expect(200);
    const rows = await entries('thread.answer', thread.id);
    expect(rows).toEqual([expect.objectContaining({ key: 'thread.answer', resourceId: thread.id, projectId: world.projectId, summary: 'answered' })]);
    expect(rows[0]?.summary).not.toContain('secret-answer');
  });

  it('AC-5: stop without a live session refuses with 409 and records nothing', async () => {
    const thread = await projectThread();
    const response = await projectPost(thread.id, 'stop').expect(409);
    expect(response.body.message).toBe('Thread has no active session');
    expect(await entries('thread.stop', thread.id)).toEqual([]);
  });

  it('AC-6: workspace stop records against the home project', async () => {
    const runnerRow = await runner();
    const thread = await workspaceThread({ runnerId: runnerRow.id });
    await liveSession(thread.id, runnerRow.id);
    await workspacePost(thread.id, 'stop').expect(200);
    expect(await entries('thread.stop', thread.id)).toEqual([expect.objectContaining({ key: 'thread.stop', resourceId: thread.id, projectId: world.projectId, summary: 'stop requested' })]);
  });

  it('AC-7: workspace answer records thread.answer', async () => {
    const runnerRow = await runner();
    const thread = await workspaceThread({ runnerId: runnerRow.id, pendingQuestion: { requestId: 'workspace-request' } });
    await liveSession(thread.id, runnerRow.id);
    await workspacePost(thread.id, 'answer', { requestId: 'workspace-request', text: 'secret-answer' }).expect(200);
    expect(await entries('thread.answer', thread.id)).toEqual([expect.objectContaining({ key: 'thread.answer', projectId: world.projectId, summary: 'answered' })]);
  });

  it('AC-8: publish creating a job records that job id in the summary', async () => {
    const runnerRow = await runner();
    const thread = await projectThread({ runnerId: runnerRow.id, writtenPaths: ['docs/changed.md'] });
    const response = await projectPost(thread.id, 'publish').expect(200);
    const jobId = data<{ jobId: string }>(response).jobId;
    const rows = await entries('thread.publish', thread.id);
    expect(rows).toEqual([expect.objectContaining({ key: 'thread.publish', resourceId: thread.id, projectId: world.projectId, summary: `publish job ${jobId}` })]);
    expect(await db.runner.findUnique({ where: { id: runnerRow.id } })).not.toBeNull();
  });

  it('AC-9: publish into a live session records its session job id despite a null response jobId', async () => {
    const runnerRow = await runner();
    const thread = await projectThread({ runnerId: runnerRow.id });
    const job = await liveSession(thread.id, runnerRow.id);
    const response = await projectPost(thread.id, 'publish').expect(200);
    expect(data<{ jobId: string | null }>(response).jobId).toBeNull();
    expect(await entries('thread.publish', thread.id)).toEqual([expect.objectContaining({ key: 'thread.publish', resourceId: thread.id, projectId: world.projectId, summary: `publish into session ${job.id}` })]);
  });

  it('AC-10: publish without paths or an active session refuses and records nothing', async () => {
    const runnerRow = await runner();
    const thread = await projectThread({ runnerId: runnerRow.id });
    await projectPost(thread.id, 'publish').expect(409);
    expect(await entries('thread.publish', thread.id)).toEqual([]);
  });

  it('AC-11: discard records its newly created job id in the summary', async () => {
    const runnerRow = await runner();
    const thread = await projectThread({ runnerId: runnerRow.id });
    const response = await projectPost(thread.id, 'discard').expect(200);
    const jobId = data<{ jobId: string }>(response).jobId;
    expect(await entries('thread.discard', thread.id)).toEqual([expect.objectContaining({ key: 'thread.discard', resourceId: thread.id, projectId: world.projectId, summary: `discard job ${jobId}` })]);
  });
});

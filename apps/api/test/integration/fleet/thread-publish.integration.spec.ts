import { canRunDbTests } from '../../helpers/test-environment';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../../src/app.module';
import { AppFactory, NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { CombinedAuthGuard } from '../../../src/auth/guards/combined-auth.guard';
import { FLEET_CFG, IFleetConfig } from '../../../src/config/fleet.config';
import { resetDb } from '../../helpers/reset-db';
import { seedFleetHttpWorld, FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { PrismaFleetJobRepository } from '../../../src/fleet/jobs/prisma-fleet-job.repository';
import { ThreadJobEffects } from '../../../src/fleet/threads/thread-job-effects';
import type { FleetJobRecord } from '../../../src/fleet/jobs/domain/fleet-job.domain';

// The nax sandbox withholds host Postgres/Docker.
const describeDb = canRunDbTests() ? describe : describe.skip;
const DATABASE_URL = process.env.DATABASE_URL;

describeDb('US-003 thread publish', () => {
  let app: NathApplication;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  let config: IFleetConfig;

  beforeAll(async () => {
    if (!DATABASE_URL) return;
    await resetDb();
    app = await AppFactory.create(AppModule, { abortOnError: false });
    app.setJwtAuthGuard(app.get(CombinedAuthGuard));
    app.useAppGlobalPrefix().useAppGlobalPipes().useAppGlobalFilters().useAppGlobalGuards();
    await app.init();
    httpServer = app.getHttpServer();
    db = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(httpServer, db);
    config = app.get<IFleetConfig>(FLEET_CFG);
    config.threadsEnabled = true;
  }, 30_000);

  afterAll(async () => { if (app) await app.close(); });

  const makeThread = (over: Record<string, unknown> = {}) => db.chatThread.create({ data: {
    projectId: world.projectId, repoId: world.repoId, baseRef: 'trunk', feature: `publish-${Math.random().toString(36).slice(2)}`,
    title: 'Publish test', createdById: world.ids.dev, backend: { kind: 'native', model: 'm1' }, skills: [],
    specPath: '.nax/features/publish/spec.md', ...over,
  } });
  const publish = (id: string, token = world.tokens.dev) => request(httpServer)
    .post(`/api/projects/web/threads/${id}/publish`).set('Authorization', `Bearer ${token}`).send({});
  const makeRunner = (name: string) => db.runner.create({ data: {
    name, apiKeyHash: name, os: 'linux', arch: 'x64', labels: [], capacity: 2, capabilities: { threadWrite: true },
    daemonVersion: '0.1.0', protocolVersion: 4, bootId: name, enabled: true, lastSeenAt: new Date(), createdById: world.ids.root,
  } });
  const send = (id: string) => request(httpServer).post(`/api/projects/web/threads/${id}/messages`)
    .set('Authorization', `Bearer ${world.tokens.dev}`).send({ text: 'hello', clientMessageId: 'publish-busy' });

  it('AC-2: refuses a message while a PLAN job for the thread is queued', async () => {
    const thread = await makeThread();
    await db.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'feat/plan', command: 'PLAN', feature: thread.feature,
      profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, state: 'QUEUED', threadId: thread.id,
    } });
    const response = await send(thread.id).expect(409);
    expect(response.body.message).toContain('Another job of this thread is still active');
    expect(await db.chatMessage.count({ where: { threadId: thread.id } })).toBe(0);
  });

  it('AC-10: refuses publish without written paths and creates no job', async () => {
    const thread = await makeThread();
    const response = await publish(thread.id).expect(409);
    expect(response.body.message).toContain('nothing to publish');
    expect(await db.fleetJob.count({ where: { threadId: thread.id } })).toBe(0);
  });

  it('AC-3: queues one THREAD_PUBLISH command on an idle live session at its epoch', async () => {
    const runner = await makeRunner(`publish-live-${Math.random().toString(36).slice(2)}`);
    const thread = await makeThread({ runnerId: runner.id });
    const job = await db.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${thread.id}`,
      profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, state: 'RUNNING', leaseEpoch: 7,
      runnerId: runner.id, threadId: thread.id,
    } });
    await db.fleetThreadTurn.create({ data: {
      jobId: job.id, threadId: thread.id, action: 'SESSION', initialMessageId: null, instructions: '',
      backend: { kind: 'native', model: 'm1' }, skills: [], resume: false,
    } });
    await publish(thread.id).expect(200);
    const commands = await db.fleetCommand.findMany({ where: { jobId: job.id, type: 'THREAD_PUBLISH' } });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ leaseEpoch: 7, payload: {} });
  });

  it('AC-4: refuses publish while a thread message is streaming', async () => {
    const runner = await makeRunner(`publish-streaming-${Math.random().toString(36).slice(2)}`);
    const thread = await makeThread({ runnerId: runner.id });
    const job = await db.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${thread.id}`,
      profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, state: 'RUNNING', leaseEpoch: 3,
      runnerId: runner.id, threadId: thread.id,
    } });
    await db.fleetThreadTurn.create({ data: {
      jobId: job.id, threadId: thread.id, action: 'SESSION', initialMessageId: null, instructions: '',
      backend: { kind: 'native', model: 'm1' }, skills: [], resume: false,
    } });
    await db.chatMessage.create({ data: {
      threadId: thread.id, seq: 1, role: 'assistant', content: 'streaming', status: 'streaming',
    } });
    const response = await publish(thread.id).expect(409);
    expect(response.body.message).toContain('thread turn is already running');
    expect(await db.fleetCommand.count({ where: { jobId: job.id, type: 'THREAD_PUBLISH' } })).toBe(0);
  });

  it('AC-5: refuses publish while THREAD_CLOSE is queued at the live epoch', async () => {
    const runner = await makeRunner(`publish-closing-${Math.random().toString(36).slice(2)}`);
    const thread = await makeThread({ runnerId: runner.id });
    const job = await db.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${thread.id}`,
      profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, state: 'RUNNING', leaseEpoch: 5,
      runnerId: runner.id, threadId: thread.id,
    } });
    await db.fleetThreadTurn.create({ data: {
      jobId: job.id, threadId: thread.id, action: 'SESSION', initialMessageId: null, instructions: '',
      backend: { kind: 'native', model: 'm1' }, skills: [], resume: false,
    } });
    await db.fleetCommand.create({ data: { jobId: job.id, runnerId: runner.id, leaseEpoch: 5, type: 'THREAD_CLOSE', payload: {} } });
    const response = await publish(thread.id).expect(409);
    expect(response.body.message).toContain('closing');
    expect(await db.fleetCommand.count({ where: { jobId: job.id, type: 'THREAD_PUBLISH' } })).toBe(0);
  });

  it('AC-11: refuses publish when the thread has no pinned runner', async () => {
    const thread = await makeThread({ writtenPaths: ['docs/a.md'] });
    const response = await publish(thread.id).expect(409);
    expect(response.body.message).toContain('nothing to publish');
  });

  it('AC-6: refuses a pinned runner without threadWrite capability', async () => {
    const runner = await db.runner.create({ data: {
      name: `publish-no-write-${Math.random().toString(36).slice(2)}`, apiKeyHash: `publish-no-write-${Math.random()}`,
      os: 'linux', arch: 'x64', labels: [], capacity: 1, capabilities: {}, daemonVersion: '0.1.0', protocolVersion: 4,
      bootId: 'no-write', enabled: true, lastSeenAt: new Date(), createdById: world.ids.root,
    } });
    const thread = await makeThread({ runnerId: runner.id, writtenPaths: ['docs/a.md'] });
    const response = await publish(thread.id).expect(409);
    expect(response.body.message).toContain('outdated');
  });

  it('AC-12: refuses publish while a RUN job for the thread is active', async () => {
    const runner = await makeRunner(`publish-run-${Math.random().toString(36).slice(2)}`);
    const thread = await makeThread({ runnerId: runner.id, writtenPaths: ['docs/a.md'] });
    await db.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'feat/publish', command: 'RUN', feature: thread.feature,
      profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, state: 'RUNNING', threadId: thread.id,
    } });
    const response = await publish(thread.id).expect(409);
    expect(response.body.message).toContain('Another job of this thread is still active');
  });

  it('AC-13: refuses publish by a project member who is not the creator with 403 permissions', async () => {
    const thread = await makeThread({ writtenPaths: ['docs/a.md'] });
    const response = await publish(thread.id, world.tokens.viewer).expect(403);
    // Permissions P1 US-002: the creator compare asks for the `thread.publish` any-row key.
    expect(response.body).toEqual(expect.objectContaining({ ret: 40003, message: 'You do not have permissions to perform this action' }));
    expect(await db.fleetJob.count({ where: { threadId: thread.id } })).toBe(0);
    expect(await db.fleetCommand.count({ where: { job: { threadId: thread.id } } })).toBe(0);
  });

  it('AC-7/8: creates a zero-cost PUBLISH job and action turn for written paths', async () => {
    const runner = await makeRunner(`publish-job-${Math.random().toString(36).slice(2)}`);
    const thread = await makeThread({ runnerId: runner.id, writtenPaths: ['docs/a.md'], costUsd: 5, maxCostUsd: 1 });
    const response = await publish(thread.id).expect(200);
    const { jobId } = response.body.data as { jobId: string };
    expect(jobId).toBeTruthy();
    const job = await db.fleetJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.command).toBe('THREAD');
    expect(job.maxCostUsd.toString()).toBe('0');
    expect(await db.fleetThreadTurn.findUniqueOrThrow({ where: { jobId } })).toMatchObject({
      action: 'PUBLISH', initialMessageId: null, resume: false,
    });
    const assign = await app.get(PrismaFleetJobRepository).findThreadAssign(jobId);
    expect(assign).toMatchObject({ action: 'PUBLISH', initialMessage: null, title: thread.title });
  });

  it('AC-15: PUBLISH completion leaves a closed earlier session snapshot unchanged', async () => {
    const session = {
      jobId: 'earlier-session-job', state: 'closed', resumed: true, contextReset: false,
      reason: 'session ended', at: '2026-10-01T00:00:00.000Z',
    };
    const thread = await makeThread({ session });
    const job = await db.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${thread.id}`,
      profiles: [], maxCostUsd: 0, selectorLabels: [], requestedById: world.ids.dev, state: 'COMPLETED',
      stateReason: 'published', threadId: thread.id, finishedAt: new Date('2026-10-02T00:00:00.000Z'),
    } });
    await app.get(ThreadJobEffects).onJobEnded(job as unknown as FleetJobRecord);
    const saved = await db.chatThread.findUniqueOrThrow({ where: { id: thread.id }, select: { session: true } });
    expect(saved.session).toEqual(session);
  });

  it('AC-1: refuses a send while a PUBLISH thread job is active', async () => {
    const thread = await makeThread();
    const job = await db.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${thread.id}`,
      profiles: [], maxCostUsd: 0, selectorLabels: [], requestedById: world.ids.dev, state: 'RUNNING', threadId: thread.id,
    } });
    await db.fleetThreadTurn.create({ data: {
      jobId: job.id, threadId: thread.id, action: 'PUBLISH', initialMessageId: null, instructions: '',
      backend: { kind: 'native', model: 'm1' }, skills: [], resume: false,
    } });
    const response = await send(thread.id).expect(409);
    expect(response.body.message).toContain('Another job of this thread is still active');
    expect(await db.chatMessage.count({ where: { threadId: thread.id } })).toBe(0);
  });
});

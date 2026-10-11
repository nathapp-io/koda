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

const describeDb = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const DATABASE_URL = process.env.DATABASE_URL;

describe('US-005 thread send guards', () => {
  it('US-005 AC1: archived refusal wins over the cost cap', async () => {
    let sendRefusal: ((state: never) => string | null) | undefined;
    try {
      const rules = await import('../../../src/fleet/threads/thread-send-rules');
      sendRefusal = rules.sendRefusal as (state: never) => string | null;
    } catch {
      // Keep the missing export observable as an assertion failure in the RED state.
    }
    expect(typeof sendRefusal).toBe('function');
    expect(sendRefusal?.({ status: 'ARCHIVED', costUsd: 5, maxCostUsd: 5 } as never)).toBe('archived');
  });
});

describeDb('US-005 thread send HTTP guards', () => {
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

  afterEach(async () => { await db.runner.deleteMany({ where: { name: { in: ['offline-send-guard', 'old-protocol-guard', 'closing-runner'] } } }); });
  afterAll(async () => { if (app) await app.close(); });

  const makeThread = (over: Record<string, unknown> = {}) => db.chatThread.create({ data: {
    projectId: world.projectId, repoId: world.repoId, baseRef: 'trunk', feature: `guard-${Math.random().toString(36).slice(2)}`,
    title: 'Guard test', createdById: world.ids.dev, backend: { kind: 'native', model: 'm1' }, skills: [],
    specPath: '.nax/features/guard/spec.md', ...over,
  } });
  const send = (id: string, token = world.tokens.dev, clientMessageId = 'guard-message', text = 'hello') =>
    request(httpServer).post(`/api/projects/web/threads/${id}/messages`).set('Authorization', `Bearer ${token}`).send({ text, clientMessageId });
  const message = (res: request.Response) => res.body.data as { message: { id: string; status: string }; jobId: string | null };

  it('US-005 AC2: refuses to requeue a CRASHED THREAD job without changing its state', async () => {
    const thread = await makeThread();
    const job = await db.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${thread.id}`,
      profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, state: 'CRASHED', threadId: thread.id,
    } });
    const res = await request(httpServer).post(`/api/projects/web/fleet/jobs/${job.id}/requeue`).set('Authorization', `Bearer ${world.tokens.dev}`).send().expect(409);
    expect(res.body.message).toContain('The job is CRASHED');
    expect((await db.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).state).toBe('CRASHED');
  });

  it('US-005 AC3: refuses a send by a project developer who is not the creator', async () => {
    const thread = await makeThread({ createdById: world.ids.root });
    const res = await send(thread.id).expect(403);
    expect(res.body.message).toBe('Only the thread creator can perform this action');
  });

  it('US-005 AC4: refuses creator send while threads are disabled', async () => {
    config.threadsEnabled = false;
    try { const res = await send((await makeThread()).id).expect(409); expect(res.body.message).toContain('disabled'); }
    finally { config.threadsEnabled = true; }
  });

  it('US-005 AC5: refuses sends on archived threads', async () => {
    const thread = await makeThread({ status: 'ARCHIVED', archivedAt: new Date() });
    const res = await send(thread.id).expect(409);
    expect(res.body.message).toContain('archived');
  });

  it('US-005 AC6: refuses sends at the thread cost cap', async () => {
    const thread = await makeThread({ costUsd: 5, maxCostUsd: 5 });
    const res = await send(thread.id).expect(409);
    expect(res.body.message).toContain('cost cap');
  });

  it('US-005 AC7: refuses sends under a paused project budget policy', async () => {
    const now = new Date();
    const policy = await db.budgetPolicy.create({ data: {
      scopeType: 'project', scopeId: world.projectId, scopeKey: `project:${world.projectId}`, projectId: world.projectId,
      windowKind: 'lifetime', amountUsd: 10, hardStop: true, pausedAt: now, pausedWindowStart: new Date(0),
      createdById: world.ids.root, updatedById: world.ids.root,
    } });
    try {
      const res = await send((await makeThread()).id).expect(409);
      expect(res.body.message).toContain('budget');
    } finally {
      // Lifetime project pause would otherwise gate every later send in this project (AC8-AC15).
      await db.budgetPolicy.delete({ where: { id: policy.id } });
    }
  });

  it('US-005 AC8: refuses an offline pinned runner without inserting a message', async () => {
    const old = new Date(Date.now() - (config.runnerOfflineSec + 60) * 1000);
    const runner = await db.runner.create({ data: {
      name: 'offline-send-guard', apiKeyHash: 'offline-send-guard', os: 'linux', arch: 'x64', labels: [], capacity: 1,
      capabilities: {}, daemonVersion: '0.1.0', protocolVersion: 4, bootId: 'offline', enabled: true, lastSeenAt: old,
      createdById: world.ids.root,
    } });
    const thread = await makeThread({ runnerId: runner.id });
    const res = await send(thread.id).expect(409);
    expect(res.body.message).toContain('offline');
    expect(await db.chatMessage.count({ where: { threadId: thread.id } })).toBe(0);
  });

  it('US-005 AC9: refuses an online runner on an older protocol', async () => {
    const runner = await db.runner.create({ data: {
      name: 'old-protocol-guard', apiKeyHash: 'old-protocol-guard', os: 'linux', arch: 'x64', labels: [], capacity: 1,
      capabilities: {}, daemonVersion: '0.1.0', protocolVersion: 3, bootId: 'old', enabled: true, lastSeenAt: new Date(),
      createdById: world.ids.root,
    } });
    const res = await send((await makeThread({ runnerId: runner.id })).id).expect(409);
    expect(res.body.message).toContain('outdated');
  });

  it('US-005 AC10: refuses when the current THREAD job is uploading', async () => {
    const thread = await makeThread();
    await db.fleetJob.create({ data: { projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${thread.id}`, profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, state: 'UPLOADING', threadId: thread.id } });
    const res = await send(thread.id).expect(409);
    expect(res.body.message).toContain('closing');
  });

  it('US-005 AC11: refuses when a THREAD_CLOSE command is pending at the running job epoch', async () => {
    const thread = await makeThread();
    const runner = await db.runner.create({ data: {
      name: 'closing-runner', apiKeyHash: 'closing-runner', os: 'linux', arch: 'x64', labels: [], capacity: 1,
      capabilities: {}, daemonVersion: '0.1.0', protocolVersion: 4, bootId: 'closing', enabled: true, lastSeenAt: new Date(),
      createdById: world.ids.root,
    } });
    const job = await db.fleetJob.create({ data: { projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${thread.id}`, profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, state: 'RUNNING', leaseEpoch: 2, runnerId: runner.id, threadId: thread.id } });
    await db.fleetCommand.create({ data: { jobId: job.id, runnerId: runner.id, leaseEpoch: 2, type: 'THREAD_CLOSE', payload: {} } });
    const res = await send(thread.id).expect(409);
    expect(res.body.message).toContain('closing');
  });

  it('US-005 AC12: refuses while a thread message is pending', async () => {
    const thread = await makeThread();
    await db.chatThread.update({ where: { id: thread.id }, data: { nextSeq: 2 } });
    await db.chatMessage.create({ data: { threadId: thread.id, seq: 1, role: 'user', authorUserId: world.ids.dev, content: 'pending', status: 'pending' } });
    const res = await send(thread.id).expect(409);
    expect(res.body.message).toContain('turn');
  });

  it('US-005 AC13: rejects text larger than 32 KiB in UTF-8 bytes', async () => {
    const res = await send((await makeThread()).id, world.tokens.dev, 'oversized', 'é'.repeat(16_385)).expect(400);
    expect(res.body.message).toContain('input');
  });

  it('US-005 AC14: persists the first turn pending and leaves its job queued when no runner fits', async () => {
    const thread = await makeThread();
    const res = await send(thread.id).expect(201);
    expect(message(res).message.status).toBe('pending');
    const job = await db.fleetJob.findUniqueOrThrow({ where: { id: message(res).jobId ?? '' } });
    expect(job).toMatchObject({ command: 'THREAD', state: 'QUEUED', pinnedRunnerId: null });
  });

  it('US-005 AC15: deduplicates the same client message id before archived-state refusal', async () => {
    const thread = await makeThread();
    const first = await send(thread.id, world.tokens.dev, 'same-client-id').expect(201);
    await db.chatThread.update({ where: { id: thread.id }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
    const repeated = await send(thread.id, world.tokens.dev, 'same-client-id').expect(200);
    expect(message(repeated).message.id).toBe(message(first).message.id);
  });
});

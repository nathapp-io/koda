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

// The nax sandbox withholds host Postgres/Docker.
const describeDb = canRunDbTests() ? describe : describe.skip;
const DATABASE_URL = process.env.DATABASE_URL;

describeDb('US-004 thread discard', () => {
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

  const uid = () => Math.random().toString(36).slice(2);
  const makeThread = (over: Record<string, unknown> = {}) => db.chatThread.create({ data: {
    projectId: world.projectId, repoId: world.repoId, baseRef: 'trunk', feature: `discard-${uid()}`,
    title: 'Discard test', createdById: world.ids.dev, backend: { kind: 'native', model: 'm1' }, skills: [],
    specPath: '.nax/features/discard/spec.md', ...over,
  } });
  const discard = (id: string, token = world.tokens.dev) => request(httpServer)
    .post(`/api/projects/web/threads/${id}/discard`).set('Authorization', `Bearer ${token}`).send({});
  const makeRunner = (name: string) => db.runner.create({ data: {
    name, apiKeyHash: name, os: 'linux', arch: 'x64', labels: [], capacity: 2, capabilities: { threadWrite: true },
    daemonVersion: '0.1.0', protocolVersion: 4, bootId: name, enabled: true, lastSeenAt: new Date(), createdById: world.ids.root,
  } });
  /** A THREAD job of the thread in `state`, with its turn of `action` (a SESSION, PUBLISH or DISCARD). */
  const activeJob = async (threadId: string, runnerId: string | null, action: string, state = 'RUNNING') => {
    const job = await db.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${threadId}`,
      profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, state, leaseEpoch: 2, runnerId, threadId,
    } });
    await db.fleetThreadTurn.create({ data: {
      jobId: job.id, threadId, action, initialMessageId: null, instructions: '',
      backend: { kind: 'native', model: 'm1' }, skills: [], resume: false,
    } });
    return job;
  };

  it('AC-1: creates a zero-cost DISCARD job and turn for an idle pinned thread', async () => {
    const runner = await makeRunner(`discard-idle-${uid()}`);
    const thread = await makeThread({ runnerId: runner.id });
    const response = await discard(thread.id).expect(200);
    const { jobId } = response.body.data as { jobId: string };
    expect(jobId).toBeTruthy();
    const job = await db.fleetJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job).toMatchObject({ command: 'THREAD', threadId: thread.id });
    expect(job.maxCostUsd.toString()).toBe('0');
    expect(await db.fleetThreadTurn.findUniqueOrThrow({ where: { jobId } })).toMatchObject({
      action: 'DISCARD', initialMessageId: null, resume: false,
    });
  });

  it('AC-2: the DISCARD ASSIGN source carries action DISCARD and no initial message', async () => {
    const runner = await makeRunner(`discard-assign-${uid()}`);
    const thread = await makeThread({ runnerId: runner.id });
    const { jobId } = (await discard(thread.id).expect(200)).body.data as { jobId: string };
    expect(await app.get(PrismaFleetJobRepository).findThreadAssign(jobId)).toMatchObject({ action: 'DISCARD', initialMessage: null });
  });

  it('AC-3: refuses with busy while the thread SESSION job is RUNNING', async () => {
    const runner = await makeRunner(`discard-busy-${uid()}`);
    const thread = await makeThread({ runnerId: runner.id });
    await activeJob(thread.id, runner.id, 'SESSION');
    const response = await discard(thread.id).expect(409);
    expect(response.body.message).toContain('Another job of this thread is still active');
    expect(await db.fleetJob.count({ where: { threadId: thread.id, command: 'THREAD', threadTurn: { action: 'DISCARD' } } })).toBe(0);
  });

  it('AC-5: refuses with nothingToDiscard when the thread has no pinned runner', async () => {
    const thread = await makeThread();
    const response = await discard(thread.id).expect(409);
    expect(response.body.message).toContain('nothing to discard');
    expect(await db.fleetJob.count({ where: { threadId: thread.id } })).toBe(0);
  });

  it('AC-4: refuses a pinned runner without threadWrite as outdated', async () => {
    const runner = await db.runner.create({ data: {
      name: `discard-no-write-${uid()}`, apiKeyHash: `discard-no-write-${uid()}`, os: 'linux', arch: 'x64', labels: [],
      capacity: 1, capabilities: {}, daemonVersion: '0.1.0', protocolVersion: 4, bootId: 'no-write', enabled: true,
      lastSeenAt: new Date(), createdById: world.ids.root,
    } });
    const thread = await makeThread({ runnerId: runner.id });
    const response = await discard(thread.id).expect(409);
    expect(response.body.message).toContain('outdated');
  });

  it('AC-6: refuses with busy while a PLAN job for the thread is queued', async () => {
    const runner = await makeRunner(`discard-plan-${uid()}`);
    const thread = await makeThread({ runnerId: runner.id });
    await db.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'feat/plan', command: 'PLAN', feature: thread.feature,
      profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, state: 'QUEUED', threadId: thread.id,
    } });
    const response = await discard(thread.id).expect(409);
    expect(response.body.message).toContain('Another job of this thread is still active');
  });

  it('AC-7: refuses a project member who is not the creator with 403 permissions', async () => {
    const runner = await makeRunner(`discard-creator-${uid()}`);
    const thread = await makeThread({ runnerId: runner.id });
    const response = await discard(thread.id, world.tokens.viewer).expect(403);
    // Permissions P1 US-002: the creator compare asks for the `thread.discard` any-row key.
    expect(response.body).toEqual(expect.objectContaining({ ret: 40003, message: 'You do not have permissions to perform this action' }));
    expect(await db.fleetJob.count({ where: { threadId: thread.id } })).toBe(0);
  });
});

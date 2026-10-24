import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet S5a US-007 — startup catch-up of unfolded thread streams (PG).
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/thread-ingest-bootstrap.integration.spec.ts
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { LogStore, LOG_STORE, logKey } from '../../../src/fleet/logs/log-store';
import { ThreadIngestor } from '../../../src/fleet/threads/ingest/thread-ingestor';
import { ThreadIngestBootstrap } from '../../../src/fleet/threads/ingest/thread-ingest.bootstrap';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
const ENV = ['FLEET_ARTIFACT_DIR'] as const;

describeIntegration('fleet thread ingest startup catch-up (PG, US-007)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runnerId: string;
  let store: LogStore;
  let ingestor: ThreadIngestor;
  const saved: Record<string, string | undefined> = {};
  let artifactDir: string;

  const START = { type: 'turn_start', turnId: 't1' };
  const DELTA_HI = { type: 'text_delta', turnId: 't1', round: 1, text: 'Hi' };
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

  beforeAll(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    artifactDir = mkdtempSync(join(tmpdir(), 'koda-thread-bootstrap-'));
    process.env.FLEET_ARTIFACT_DIR = artifactDir;
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    runnerId = (await enrollRunner(app.getHttpServer(), world.tokens.root, 'bootstrap-runner')).runnerId;
    store = app.get<LogStore>(LOG_STORE);
    ingestor = app.get(ThreadIngestor);
  });
  afterAll(async () => {
    await app.close();
    rmSync(artifactDir, { recursive: true, force: true });
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  /** A thread with one THREAD job at lease epoch 1 held by the shared runner, in the given state. */
  async function seedJob(name: string, over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}): Promise<{ threadId: string; jobId: string }> {
    const thread = await prisma.chatThread.create({ data: {
      projectId: world.projectId, repoId: world.repoId, baseRef: 'trunk', feature: name, title: 'Bootstrap fixture',
      createdById: world.ids.dev, runnerId, backend: { kind: 'native', model: 'm1' }, skills: [], specPath: `.nax/features/${name}/spec.md`,
    } });
    const job = await prisma.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${thread.id}`,
      profiles: [], selectorLabels: [], maxCostUsd: new Prisma.Decimal(5), requestedById: world.ids.dev,
      state: 'RUNNING', runnerId, leaseEpoch: 1, firstStartedAt: new Date(), threadId: thread.id, ...over,
    } });
    return { threadId: thread.id, jobId: job.id };
  }

  /** Appends JSONL lines straight into the stream store and records the FleetJobLog size, as an upload would. */
  async function writeStream(jobId: string, lines: object[]): Promise<number> {
    const key = logKey(jobId, 1, 'thread');
    const bytes = Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8');
    const size = await store.withLock(key, async () => {
      const result = await store.append(key, await store.size(key), bytes);
      if (result.kind !== 'appended') throw new Error(`thread stream write refused: ${result.kind}`);
      return store.size(key);
    });
    await prisma.fleetJobLog.upsert({
      where: { jobId_leaseEpoch_stream: { jobId, leaseEpoch: 1, stream: 'thread' } },
      create: { jobId, leaseEpoch: 1, stream: 'thread', sizeBytes: BigInt(size) },
      update: { sizeBytes: BigInt(size) },
    });
    return size;
  }

  const cursorOf = (jobId: string) => prisma.threadIngestCursor.findUnique({ where: { jobId_leaseEpoch: { jobId, leaseEpoch: 1 } } });
  const assistantOf = (threadId: string) => prisma.chatMessage.findFirst({ where: { threadId, role: 'assistant' } });
  const bootstrap = () => app.get(ThreadIngestBootstrap).onApplicationBootstrap();

  it('US-007 AC1: a RUNNING THREAD job with an unfolded stream is folded at startup, cursor at the file size', async () => {
    const s = await seedJob('ac1');
    const size = await writeStream(s.jobId, [START, DELTA_HI]);
    await bootstrap();
    expect(await assistantOf(s.threadId)).toMatchObject({ content: 'Hi' });
    expect(await cursorOf(s.jobId)).toMatchObject({ offset: BigInt(size) });
  });

  it('US-007 AC2: a COMPLETED THREAD job whose finish is 2 hours old is folded at startup', async () => {
    const s = await seedJob('ac2', { state: 'COMPLETED', finishedAt: hoursAgo(2) });
    const size = await writeStream(s.jobId, [START, DELTA_HI]);
    await bootstrap();
    expect(await assistantOf(s.threadId)).toMatchObject({ content: 'Hi' });
    expect(await cursorOf(s.jobId)).toMatchObject({ offset: BigInt(size) });
  });

  it('US-007 AC3: a COMPLETED THREAD job finished 3 days ago is not caught up', async () => {
    const s = await seedJob('ac3', { state: 'COMPLETED', finishedAt: hoursAgo(72) });
    await writeStream(s.jobId, [START, DELTA_HI]);
    await bootstrap();
    expect(await cursorOf(s.jobId)).toBeNull();
    expect(await assistantOf(s.threadId)).toBeNull();
  });

  it('US-007 AC4: a RUNNING THREAD job whose cursor offset equals its sizeBytes is not passed to catchUp', async () => {
    const s = await seedJob('ac4');
    const size = await writeStream(s.jobId, [START]);
    await prisma.threadIngestCursor.create({ data: { jobId: s.jobId, leaseEpoch: 1, offset: BigInt(size), skippedLines: 0 } });
    const spy = vi.spyOn(ingestor, 'catchUp');
    try {
      await bootstrap();
      expect(spy).not.toHaveBeenCalledWith(s.jobId, 1);
    } finally {
      spy.mockRestore();
    }
  });

  it('US-007: an unfolded stream of a requeued job\'s earlier epoch is folded at that epoch', async () => {
    // The job moved on to epoch 2; epoch 1's stream still holds bytes its cursor never reached.
    const s = await seedJob('prior-epoch', { leaseEpoch: 2 });
    const key = logKey(s.jobId, 1, 'thread');
    const bytes = Buffer.from(`${JSON.stringify(START)}\n${JSON.stringify(DELTA_HI)}\n`, 'utf8');
    const size = await store.withLock(key, async () => {
      await store.append(key, 0, bytes);
      return store.size(key);
    });
    await prisma.fleetJobLog.create({ data: { jobId: s.jobId, leaseEpoch: 1, stream: 'thread', sizeBytes: BigInt(size) } });
    await bootstrap();
    expect(await assistantOf(s.threadId)).toMatchObject({ content: 'Hi', jobId: s.jobId });
    expect(await prisma.threadIngestCursor.findUnique({ where: { jobId_leaseEpoch: { jobId: s.jobId, leaseEpoch: 1 } } }))
      .toMatchObject({ offset: BigInt(size) });
  });

  it('US-007 AC5: a failing catchUp is logged and the next job in order is still folded', async () => {
    const first = await seedJob('ac5-first', { queuedAt: hoursAgo(3) });
    const second = await seedJob('ac5-second', { queuedAt: hoursAgo(2) });
    await writeStream(first.jobId, [START]);
    await writeStream(second.jobId, [START, DELTA_HI]);
    const spy = vi.spyOn(ingestor, 'catchUp').mockRejectedValueOnce(new Error('fold failed'));
    try {
      await expect(bootstrap()).resolves.toBeUndefined();
      expect(spy).toHaveBeenNthCalledWith(1, first.jobId, 1);
      expect(spy).toHaveBeenCalledWith(second.jobId, 1);
      expect(await cursorOf(first.jobId)).toBeNull();
      expect(await assistantOf(second.threadId)).toMatchObject({ content: 'Hi' });
    } finally {
      spy.mockRestore();
    }
  });
});

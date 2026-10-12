/**
 * Fleet S5a US-001 — the thread log stream over HTTP and the schema (PG).
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/thread-ingest-stream.integration.spec.ts
 */
import request from 'supertest';
import { createHash } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { putThreadLines, seedThreadJob, ThreadJobSeed } from '../../helpers/thread-fixtures';
import { ProjectEventBus } from '../../../src/live/project-event-bus';
import type { LiveEvent } from '../../../src/live/live-event';
import { applyMigration, scratchSchemaBefore, ScratchSchema } from '../../helpers/migration-schema';
import { createTestPrismaClient } from '../../helpers/test-prisma';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const ENV = ['FLEET_ARTIFACT_DIR', 'FLEET_LOG_MAX_BYTES', 'FLEET_LOG_CHUNK_MAX_BYTES'] as const;
const MIGRATION = '20261014090000_thread_ingest';

describeIntegration('fleet thread log stream (PG, US-001)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let thread: ThreadJobSeed;
  const saved: Record<string, string | undefined> = {};
  const events: LiveEvent[] = [];

  beforeAll(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env.FLEET_ARTIFACT_DIR = mkdtempSync(join(tmpdir(), 'koda-thread-stream-'));
    process.env.FLEET_LOG_MAX_BYTES = '4096';
    process.env.FLEET_LOG_CHUNK_MAX_BYTES = '1024';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    app.get(ProjectEventBus).subscribe(world.projectId, (e) => { events.push(e); });
    thread = await seedThreadJob(server, prisma, world);
  });
  afterAll(async () => {
    await app.close();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  // One 40-byte JSONL line with its newline. putThreadLines appends "\n" to each line.
  const LINE_40 = ['{"type":"turn_start","id":"1","pad":""}'];

  it('US-001 AC3: a 40-byte thread upload from the held runner appends and records sizeBytes 40', async () => {
    expect(Buffer.byteLength(`${LINE_40[0]}\n`, 'utf8')).toBe(40);
    const size = await putThreadLines(server, thread.runnerKey, { id: thread.jobId }, LINE_40);
    expect(size).toBe(40);
    expect(await prisma.fleetJobLog.findUniqueOrThrow({
      where: { jobId_leaseEpoch_stream: { jobId: thread.jobId, leaseEpoch: 1, stream: 'thread' } },
    })).toMatchObject({ sizeBytes: 40n });
  });

  it('US-001 AC4: a RUN job refuses the thread stream with 400 fleet.logInput', async () => {
    const run = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'RUN', feature: 'run-refusal', profiles: [],
        selectorLabels: [], maxCostUsd: new Prisma.Decimal(1), requestedById: world.ids.dev, state: 'RUNNING',
        runnerId: thread.runnerId, leaseEpoch: 1,
      },
    });
    const res = await request(server).put(`/api/fleet/runner/jobs/${run.id}/logs/thread?leaseEpoch=1&offset=0`)
      .set({ Authorization: `Bearer ${thread.runnerKey}`, 'content-type': 'application/octet-stream', 'x-content-sha256': 'a'.repeat(64) })
      .send(Buffer.from('x'))
      .expect(400);
    expect(res.body.message).toContain('Invalid log upload');
    expect(await prisma.fleetJobLog.count({ where: { jobId: run.id, stream: 'thread' } })).toBe(0);
  });

  it('US-001 AC5: the job-log list by a project member lists no stream named thread', async () => {
    const res = await request(server).get(`/api/projects/web/fleet/jobs/${thread.jobId}/logs`)
      .set('Authorization', `Bearer ${world.tokens.dev}`).expect(200);
    const streams = (res.body.data.attempts as Array<{ streams: Array<{ stream: string }> }>).flatMap((a) => a.streams.map((s) => s.stream));
    expect(streams).not.toContain('thread');
  });

  it('US-001 AC6: the entries route for the thread stream answers 404 fleet.logs', async () => {
    const res = await request(server).get(`/api/projects/web/fleet/jobs/${thread.jobId}/logs/thread/entries?leaseEpoch=1`)
      .set('Authorization', `Bearer ${world.tokens.dev}`).expect(404);
    expect(res.body.message).toBe('No log is stored for this stream or attempt');
  });

  it('US-001 AC7: an appended thread upload publishes no fleet_log, and a run upload of another job does', async () => {
    // Its own THREAD job, so the thread upload below is a real `appended` at offset 0 and does not depend on AC3.
    const liveThread = await seedThreadJob(server, prisma, world, { feature: 'live-thread' });
    const runJob = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'RUN', feature: 'live-run', profiles: [],
        selectorLabels: [], maxCostUsd: new Prisma.Decimal(1), requestedById: world.ids.dev, state: 'RUNNING',
        runnerId: thread.runnerId, leaseEpoch: 1,
      },
    });
    const before = events.length;
    const threadRes = await request(server).put(`/api/fleet/runner/jobs/${liveThread.jobId}/logs/thread?leaseEpoch=1&offset=0`)
      .set({ Authorization: `Bearer ${liveThread.runnerKey}`, 'content-type': 'application/octet-stream', 'x-content-sha256': sha256Hex(Buffer.from('{"type":"turn_end"}\n')) })
      .send(Buffer.from('{"type":"turn_end"}\n')).expect(200);
    expect(threadRes.body.data).toEqual({ outcome: 'appended', size: 20 });
    const runBody = Buffer.from('run line\n');
    await request(server).put(`/api/fleet/runner/jobs/${runJob.id}/logs/run?leaseEpoch=1&offset=0`)
      .set({ Authorization: `Bearer ${thread.runnerKey}`, 'content-type': 'application/octet-stream', 'x-content-sha256': sha256Hex(runBody) })
      .send(runBody).expect(200);
    const fresh = events.slice(before).filter((e): e is Extract<LiveEvent, { type: 'fleet_log' }> => e.type === 'fleet_log');
    expect(fresh.map((e) => e.jobId)).toEqual([runJob.id]);
  });

  describe('the migration itself', () => {
    let scratch: ScratchSchema;
    beforeAll(async () => {
      scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'thread_ingest_mig', MIGRATION);
      await scratch.db.$executeRawUnsafe(`
        INSERT INTO "User" ("id", "email", "passwordHash", "updatedAt") VALUES ('u-mig', 'mig@k.t', 'x', CURRENT_TIMESTAMP);
      `);
      await scratch.db.$executeRawUnsafe(`
        INSERT INTO "Project" ("id", "name", "slug", "key", "updatedAt") VALUES ('p-mig', 'P', 'p-mig', 'PM', CURRENT_TIMESTAMP);
      `);
      await scratch.db.$executeRawUnsafe(`
        INSERT INTO "FleetRepo" ("id", "projectId", "provider", "owner", "name", "defaultBranch", "createdById")
        VALUES ('r-mig', 'p-mig', 'github', 'acme', 'app', 'main', 'u-mig');
      `);
      await scratch.db.$executeRawUnsafe(`
        INSERT INTO "ChatThread" ("id", "projectId", "repoId", "baseRef", "feature", "title", "createdById", "backend", "skills", "specPath")
        VALUES ('t-mig', 'p-mig', 'r-mig', 'main', 'f', 'T', 'u-mig', '{"kind":"native"}', '[]', '.nax/features/f/spec.md');
      `);
      await applyMigration(scratch.db, MIGRATION);
    });
    afterAll(async () => {
      await scratch.drop();
    });

    it('US-001 AC15: the migration keeps an existing ChatThread row and leaves session null', async () => {
      const rows = await scratch.db.$queryRawUnsafe<Array<{ id: string; session: unknown }>>(
        `SELECT "id", "session" FROM "ChatThread" WHERE "id" = 't-mig'`,
      );
      expect(rows).toEqual([{ id: 't-mig', session: null }]);
    });
  });

  it('US-001 AC13: a second ThreadIngestCursor for the same job and epoch fails with a unique violation', async () => {
    const cursorPrisma = createTestPrismaClient();
    try {
      const job = await prisma.fleetJob.create({
        data: {
          projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: 'cursor-unique', profiles: [],
          selectorLabels: [], maxCostUsd: new Prisma.Decimal(1), requestedById: world.ids.dev, state: 'RUNNING', leaseEpoch: 1,
        },
      });
      await cursorPrisma.threadIngestCursor.create({ data: { jobId: job.id, leaseEpoch: 1 } });
      await expect(cursorPrisma.threadIngestCursor.create({ data: { jobId: job.id, leaseEpoch: 1 } }))
        .rejects.toMatchObject({ code: 'P2002' });
    } finally {
      await cursorPrisma.$disconnect();
    }
  });

  it('US-001 AC14: deleting a FleetJob deletes its ThreadIngestCursor rows', async () => {
    const job = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: 'cursor-cascade', profiles: [],
        selectorLabels: [], maxCostUsd: new Prisma.Decimal(1), requestedById: world.ids.dev, state: 'CANCELLED', leaseEpoch: 1,
      },
    });
    await prisma.threadIngestCursor.create({ data: { jobId: job.id, leaseEpoch: 1, offset: 0n, skippedLines: 0 } });
    await prisma.fleetJob.delete({ where: { id: job.id } });
    expect(await prisma.threadIngestCursor.count({ where: { jobId: job.id } })).toBe(0);
  });
});

const sha256Hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

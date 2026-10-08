/**
 * Fleet S2a slice 1a — log upload route over HTTP (PG), spec §2.2.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-log-upload.integration.spec.ts
 */
import request from 'supertest';
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { ProjectEventBus } from '../../../src/live/project-event-bus';
import type { LiveEvent } from '../../../src/live/live-event';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const ENV = ['FLEET_ARTIFACT_DIR', 'FLEET_LOG_MAX_BYTES', 'FLEET_LOG_CHUNK_MAX_BYTES'] as const;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describeIntegration('fleet log upload (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  const saved: Record<string, string | undefined> = {};
  const events: LiveEvent[] = [];

  const job = (feature: string, state: string, leaseEpoch = 1) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature, profiles: [], selectorLabels: [],
      maxCostUsd: new Prisma.Decimal(1), requestedById: world.ids.dev, state, runnerId: runner.runnerId, leaseEpoch,
    },
  });
  const put = (jobId: string, body: Buffer, q: { stream?: string; epoch?: number; offset?: number; final?: boolean } = {}) =>
    request(server)
      .put(`/api/fleet/runner/jobs/${jobId}/logs/${q.stream ?? 'run'}?leaseEpoch=${q.epoch ?? 1}&offset=${q.offset ?? 0}${q.final ? '&final=1' : ''}`)
      .set({ Authorization: `Bearer ${runner.apiKey}`, 'content-type': 'application/octet-stream', 'x-content-sha256': sha(body) })
      .send(body);

  beforeAll(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env.FLEET_ARTIFACT_DIR = mkdtempSync(join(tmpdir(), 'koda-log-upload-'));
    process.env.FLEET_LOG_MAX_BYTES = '64';
    process.env.FLEET_LOG_CHUNK_MAX_BYTES = '32';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'box-logs');
    app.get(ProjectEventBus).subscribe(world.projectId, (e) => { events.push(e); });
  });
  afterAll(async () => {
    await app.close();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('appends, dedupes, completes and indexes a stream; publishes fleet_log', async () => {
    const j = await job('ok', 'RUNNING');
    expect((await put(j.id, Buffer.from('a\nb\n')).expect(200)).body.data).toEqual({ outcome: 'appended', size: 4 });
    expect((await put(j.id, Buffer.from('a\nb\n')).expect(200)).body.data).toEqual({ outcome: 'duplicate', size: 4 });
    expect((await put(j.id, Buffer.from('zz'), { offset: 9 }).expect(200)).body.data).toEqual({ outcome: 'offset', size: 4 });
    expect((await put(j.id, Buffer.alloc(0), { offset: 4, final: true }).expect(200)).body.data).toEqual({ outcome: 'complete', size: 4 });
    const file = join(process.env.FLEET_ARTIFACT_DIR as string, 'logs', j.id, '1', 'run.log');
    expect(readFileSync(file, 'utf8')).toBe('a\nb\n');
    expect(await prisma.fleetJobLog.findUniqueOrThrow({ where: { jobId_leaseEpoch_stream: { jobId: j.id, leaseEpoch: 1, stream: 'run' } } }))
      .toMatchObject({ sizeBytes: 4n, complete: true, source: 'stream' });
    expect(events.filter((e) => e.type === 'fleet_log' && e.jobId === j.id).at(-1)).toMatchObject({ size: 4, complete: true });
  });

  it('fences a stale epoch (409 + ABANDON) and refuses a terminal job (409); accepts ASSIGNED', async () => {
    const stale = await job('fence', 'RUNNING', 2);
    await put(stale.id, Buffer.from('x'), { epoch: 1 }).expect(409);
    expect(await prisma.fleetCommand.count({ where: { jobId: stale.id, type: 'ABANDON' } })).toBe(1);
    await put((await job('done', 'COMPLETED')).id, Buffer.from('x')).expect(409);
    await put((await job('assigned', 'ASSIGNED')).id, Buffer.from('x')).expect(200);
  });

  it('413 past the chunk max, 422 on a bad hash, 400 on input, never throttled', async () => {
    const j = await job('errs', 'RUNNING');
    await put(j.id, Buffer.alloc(33)).expect(413);
    const body = Buffer.from('abc');
    await request(server).put(`/api/fleet/runner/jobs/${j.id}/logs/run?leaseEpoch=1&offset=0`)
      .set({ Authorization: `Bearer ${runner.apiKey}`, 'content-type': 'application/octet-stream', 'x-content-sha256': sha(Buffer.from('nope')) })
      .send(body).expect(422);
    await put(j.id, body, { stream: 'prompt' }).expect(400);
    for (let i = 0; i < 120; i += 1) await put(j.id, Buffer.from('k')).expect(200); // > 100 req/min global limit
  });

  it('cuts at the stream cap and answers stream_cap', async () => {
    const j = await job('cap', 'RUNNING');
    await put(j.id, Buffer.alloc(32, 'a')).expect(200);
    await put(j.id, Buffer.alloc(30, 'b'), { offset: 32 }).expect(200);
    expect((await put(j.id, Buffer.alloc(10, 'c'), { offset: 62 }).expect(200)).body.data).toEqual({ outcome: 'stream_cap', size: 64 });
    expect((await prisma.fleetJobLog.findFirstOrThrow({ where: { jobId: j.id } })).truncated).toBe(true);
  });

  it('refuses a user token on the runner route', async () => {
    const j = await job('auth', 'RUNNING');
    await request(server).put(`/api/fleet/runner/jobs/${j.id}/logs/run?leaseEpoch=1&offset=0`)
      .set({ Authorization: `Bearer ${world.tokens.dev}`, 'content-type': 'application/octet-stream', 'x-content-sha256': sha(Buffer.from('x')) })
      .send(Buffer.from('x')).expect((res) => expect([401, 403]).toContain(res.status));
  });
});

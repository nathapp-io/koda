/**
 * Fleet S2a slice 1c — log read routes over HTTP (PG), spec §3.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-log-read.integration.spec.ts
 */
import request from 'supertest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const line = (level: string, message: string, storyId = 'US-001') =>
  `${JSON.stringify({ timestamp: '2026-10-04T08:00:00.000Z', level, stage: 'run', storyId, message })}\n`;

describeIntegration('fleet log read routes (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let dir: string;
  const saved = process.env.FLEET_ARTIFACT_DIR;

  const job = (feature: string, over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature, profiles: [], selectorLabels: [],
      maxCostUsd: new Prisma.Decimal(1), requestedById: world.ids.dev, state: 'RUNNING', leaseEpoch: 1, ...over,
    },
  });
  const store = (jobId: string, epoch: number, stream: string, text: string) => {
    const path = join(dir, 'logs', jobId, String(epoch), `${stream}.log`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  const row = (jobId: string, epoch: number, stream: string, over: Partial<Prisma.FleetJobLogUncheckedCreateInput> = {}) =>
    prisma.fleetJobLog.create({ data: { jobId, leaseEpoch: epoch, stream, sizeBytes: 0n, ...over } });
  const get = (path: string, who: keyof FleetHttpWorld['tokens'] = 'dev') =>
    request(server).get(`/api/projects/web/fleet/jobs/${path}`).set({ Authorization: `Bearer ${world.tokens[who]}` });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'koda-log-read-'));
    process.env.FLEET_ARTIFACT_DIR = dir;
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
  });
  afterAll(async () => {
    await app.close();
    if (saved === undefined) delete process.env.FLEET_ARTIFACT_DIR;
    else process.env.FLEET_ARTIFACT_DIR = saved;
  });

  it('lists attempts with streams and a legacy sampled attempt; members only', async () => {
    const j = await job('list', { leaseEpoch: 2 });
    await row(j.id, 2, 'stdout', { sizeBytes: 3n, complete: true });
    await row(j.id, 2, 'run', { sizeBytes: 9n });
    await prisma.fleetJobEvent.create({ data: { jobId: j.id, seq: 1, leaseEpoch: 1, runnerSeq: 1, type: 'log', payload: { stream: 'run', text: 'x' } } });
    const out = data<{ attempts: Array<{ leaseEpoch: number; legacySampled: boolean; streams: Array<{ stream: string; sizeBytes: number }> }> }>(await get(`${j.id}/logs`).expect(200));
    expect(out.attempts.map((a) => [a.leaseEpoch, a.legacySampled, a.streams.map((s) => s.stream)])).toEqual([[2, false, ['run', 'stdout']], [1, true, []]]);
    expect(out.attempts[0].streams[0].sizeBytes).toBe(9);
    await get(`${j.id}/logs`, 'viewer').expect(200);
    await get(`${j.id}/logs`, 'outsider').expect(403);
    await get('nope/logs').expect(404);
  });

  it('pages entries forward and backward with filters at the job epoch by default', async () => {
    const j = await job('entries', { leaseEpoch: 3 });
    store(j.id, 3, 'run', line('info', 'one') + line('error', 'two', 'US-002') + line('warn', 'three') + 'partial');
    await row(j.id, 3, 'run', { sizeBytes: 999n });
    const all = data<{ entries: Array<{ message: string }>; atEnd: boolean; complete: boolean }>(await get(`${j.id}/logs/run/entries`).expect(200));
    expect(all.entries.map((e) => e.message)).toEqual(['one', 'two', 'three']);
    expect(all).toMatchObject({ atEnd: true, complete: false });
    const warn = data<{ entries: Array<{ message: string }> }>(await get(`${j.id}/logs/run/entries?level=warn&storyId=US-001`).expect(200));
    expect(warn.entries.map((e) => e.message)).toEqual(['three']);
    const last = data<{ entries: Array<{ message: string }>; nextCursor: number }>(await get(`${j.id}/logs/run/entries?direction=backward&limit=1`).expect(200));
    expect(last.entries.map((e) => e.message)).toEqual(['three']);
    const before = data<{ entries: Array<{ message: string }> }>(await get(`${j.id}/logs/run/entries?direction=backward&cursor=${last.nextCursor}&q=TWO`).expect(200));
    expect(before.entries.map((e) => e.message)).toEqual(['two']);
    await get(`${j.id}/logs/run/entries?limit=501`).expect(400);
    await get(`${j.id}/logs/run/entries?direction=sideways`).expect(400);
    await get(`${j.id}/logs/prompt/entries`).expect(400);
    await get(`${j.id}/logs/run/entries?leaseEpoch=4`).expect(404);
  });

  it('answers 410 for an expired stream', async () => {
    const j = await job('expired', { state: 'COMPLETED' });
    await row(j.id, 1, 'run', { sizeBytes: 5n, complete: true, expiredAt: new Date() });
    await get(`${j.id}/logs/run/entries`).expect(410);
    await get(`${j.id}/logs/run/raw`).expect(410);
    const out = data<{ attempts: Array<{ streams: Array<{ expired: boolean }> }> }>(await get(`${j.id}/logs`).expect(200));
    expect(out.attempts[0].streams[0].expired).toBe(true);
  });

  it('serves raw ranges as text/plain and downloads the whole stream as an attachment', async () => {
    const j = await job('raw');
    store(j.id, 1, 'stderr', 'hello world\n');
    await row(j.id, 1, 'stderr', { sizeBytes: 12n });
    const range = await get(`${j.id}/logs/stderr/raw?from=6&to=11`).expect(200);
    expect(range.headers['content-type']).toMatch(/^text\/plain/);
    expect(range.text).toBe('world');
    const whole = await get(`${j.id}/logs/stderr/raw?download=1`).expect(200);
    expect(whole.headers['content-disposition']).toBe(`attachment; filename="koda-job-${j.id}-1-stderr.log"`);
    expect(whole.text).toBe('hello world\n');
    await get(`${j.id}/logs/stderr/raw?from=0&to=2000000`).expect(400);
    await get(`${j.id}/logs/stdout/raw?download=1`).expect(404);
  });

  it('allows more than the global 100 requests per minute on the read routes (R10)', async () => {
    const j = await job('throttle');
    for (let i = 0; i < 130; i += 1) await get(`${j.id}/logs/run/entries`).expect(200);
  });
});

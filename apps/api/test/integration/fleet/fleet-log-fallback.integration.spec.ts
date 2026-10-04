/**
 * Fleet S2a slice 1a — bundle fallback after a bundle upload (PG), spec §2.5.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-log-fallback.integration.spec.ts
 */
import request from 'supertest';
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { tarGz } from '../../helpers/tar-gz';
import { LogFallbackService } from '../../../src/fleet/logs/log-fallback.service';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describeIntegration('fleet log fallback (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  let dir: string;
  const savedDir = process.env.FLEET_ARTIFACT_DIR;

  const job = (feature: string) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature, profiles: [], selectorLabels: [],
      maxCostUsd: new Prisma.Decimal(1), requestedById: world.ids.dev, state: 'UPLOADING', runnerId: runner.runnerId, leaseEpoch: 1, naxLogRunId: 'r1',
    },
  });
  const auth = () => ({ Authorization: `Bearer ${runner.apiKey}` });
  const putLog = (jobId: string, body: Buffer, offset: number, final = false) =>
    request(server).put(`/api/fleet/runner/jobs/${jobId}/logs/run?leaseEpoch=1&offset=${offset}${final ? '&final=1' : ''}`)
      .set({ ...auth(), 'content-type': 'application/octet-stream', 'x-content-sha256': sha(body) }).send(body);
  const putBundle = (jobId: string, gz: Buffer) =>
    request(server).put(`/api/fleet/runner/jobs/${jobId}/bundle?leaseEpoch=1`)
      .set({ ...auth(), 'content-type': 'application/gzip', 'x-content-sha256': sha(gz) }).send(gz);
  const runFile = (jobId: string) => readFileSync(join(dir, 'logs', jobId, '1', 'run.log'), 'utf8');

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'koda-log-fallback-'));
    process.env.FLEET_ARTIFACT_DIR = dir;
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'box-fallback');
  });
  afterAll(async () => {
    await app.close();
    if (savedDir === undefined) delete process.env.FLEET_ARTIFACT_DIR;
    else process.env.FLEET_ARTIFACT_DIR = savedDir;
  });

  it('fills a stream whose upload stopped before final from the uploaded bundle', async () => {
    const j = await job('cut');
    await putLog(j.id, Buffer.from('L1\n'), 0).expect(200);
    const gz = await tarGz([{ name: 'nax-out/features/cut/runs/r1.jsonl', body: 'L1\nL2\nL3\n' }, { name: 'nax.stdout', body: 'O' }]);
    await putBundle(j.id, gz).expect(201);
    await app.get(LogFallbackService).idle();
    expect(runFile(j.id)).toBe('L1\nL2\nL3\n');
    const rows = await prisma.fleetJobLog.findMany({ where: { jobId: j.id }, orderBy: { stream: 'asc' } });
    expect(rows.map((r) => [r.stream, r.complete, r.source])).toEqual([['run', true, 'bundle'], ['stdout', true, 'bundle']]);
  });

  it('a stream completed by the runner is not replaced, and a late append after the fill answers complete (Review Focus 3)', async () => {
    const j = await job('done');
    await putLog(j.id, Buffer.from('A\n'), 0).expect(200);
    await putLog(j.id, Buffer.alloc(0), 2, true).expect(200);
    await putBundle(j.id, await tarGz([{ name: 'nax-out/features/done/runs/r1.jsonl', body: 'DIFFERENT\n' }])).expect(201);
    await app.get(LogFallbackService).idle();
    expect(runFile(j.id)).toBe('A\n');

    const k = await job('late');
    await putBundle(k.id, await tarGz([{ name: 'nax-out/features/late/runs/r1.jsonl', body: 'X\nY\n' }])).expect(201);
    await app.get(LogFallbackService).idle();
    expect((await putLog(k.id, Buffer.from('X\n'), 0).expect(200)).body.data).toEqual({ outcome: 'complete', size: 4 });
    expect(runFile(k.id)).toBe('X\nY\n');
  });

  it('a bundle with no run member leaves the stream incomplete and the bundle upload succeeds', async () => {
    const j = await job('none');
    await putLog(j.id, Buffer.from('only\n'), 0).expect(200);
    await putBundle(j.id, await tarGz([{ name: 'unrelated.txt', body: 'x' }])).expect(201);
    await app.get(LogFallbackService).idle();
    expect((await prisma.fleetJobLog.findFirstOrThrow({ where: { jobId: j.id, stream: 'run' } })).complete).toBe(false);
  });
});

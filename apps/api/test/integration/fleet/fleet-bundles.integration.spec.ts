/**
 * Fleet S1 slice 2 — bundle upload (runner, fenced) and download (member), spec §3.3, §8.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-bundles.integration.spec.ts
 */
import request from 'supertest';
import { createHash } from 'crypto';
import { mkdtempSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { BundleService } from '../../../src/fleet/artifacts/bundle.service';
import { FleetFenceException } from '../../../src/fleet/artifacts/bundle.exceptions';
import { ConflictAppException } from '../../../src/common/exceptions/conflict-app.exception';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const ENV = ['FLEET_ARTIFACT_DIR', 'FLEET_BUNDLE_MAX_BYTES'] as const;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describeIntegration('fleet bundles (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  const saved: Record<string, string | undefined> = {};

  const job = (feature: string, state: string, leaseEpoch = 1) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature, profiles: [], selectorLabels: [],
      maxCostUsd: new Prisma.Decimal(1), requestedById: world.ids.dev, state, runnerId: runner.runnerId, leaseEpoch,
    },
  });
  const upload = (jobId: string, body: Buffer, over: { epoch?: number; sha?: string; type?: string } = {}) =>
    request(server).put(`/api/fleet/runner/jobs/${jobId}/bundle?leaseEpoch=${over.epoch ?? 1}`)
      .set({ Authorization: `Bearer ${runner.apiKey}`, 'content-type': over.type ?? 'application/gzip', 'x-content-sha256': over.sha ?? sha(body) })
      .send(body);
  const download = (jobId: string, who: keyof FleetHttpWorld['tokens']) =>
    request(server).get(`/api/projects/web/fleet/jobs/${jobId}/bundle`).set({ Authorization: `Bearer ${world.tokens[who]}` })
      .buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });

  beforeAll(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env.FLEET_ARTIFACT_DIR = mkdtempSync(join(tmpdir(), 'koda-bundles-'));
    process.env.FLEET_BUNDLE_MAX_BYTES = '4096';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'box-1');
  });
  afterAll(async () => {
    await app.close();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('accepts a bundle while RUNNING, replaces it on re-upload, and serves it to members', async () => {
    const j = await job('up', 'RUNNING');
    await upload(j.id, Buffer.from('first')).expect(201);
    const second = Buffer.from('second-bundle');
    await upload(j.id, second).expect(201);
    expect(await prisma.fleetJobArtifact.count({ where: { jobId: j.id } })).toBe(1);
    const dir = join(process.env.FLEET_ARTIFACT_DIR as string, 'jobs', j.id, '1');
    expect(readdirSync(dir)).toHaveLength(1); // the replaced attempt was deleted after commit
    const res = await download(j.id, 'viewer').expect(200);
    expect(res.headers['content-type']).toMatch(/application\/gzip/);
    expect(res.body).toEqual(second);
    await download(j.id, 'outsider').expect(403);
  });

  it('keeps the good bundle when a replacement has the wrong hash (422) or is too large (413)', async () => {
    const j = await job('bad', 'UPLOADING');
    const good = Buffer.from('good');
    await upload(j.id, good).expect(201);
    await upload(j.id, Buffer.from('evil'), { sha: sha(good) }).expect(422);
    await upload(j.id, Buffer.alloc(5_000)).expect(413);
    expect((await download(j.id, 'dev').expect(200)).body).toEqual(good);
  });

  it('fences: stale epoch 409 + ABANDON, wrong state 409, wrong type 415, bad hash header 400', async () => {
    const j = await job('fence', 'RUNNING', 2);
    await upload(j.id, Buffer.from('x'), { epoch: 1 }).expect(409);
    expect(await prisma.fleetCommand.count({ where: { jobId: j.id, type: 'ABANDON' } })).toBe(1);
    await upload((await job('queued', 'ASSIGNED')).id, Buffer.from('x')).expect(409);
    await upload(j.id, Buffer.from('x'), { epoch: 2, type: 'application/octet-stream' }).expect(415);
    await upload(j.id, Buffer.from('x'), { epoch: 2, sha: 'nope' }).expect(400);
    await download(j.id, 'dev').expect(404);
  });

  it('rejects a bundle whose lease was bumped between uploads (409, ABANDON, prior bundle still downloads)', async () => {
    const j = await job('midstream', 'RUNNING', 2);
    const good = Buffer.from('good-bundle');
    await upload(j.id, good, { epoch: 2 }).expect(201);
    await prisma.fleetJob.update({ where: { id: j.id }, data: { leaseEpoch: j.leaseEpoch + 1 } });
    await upload(j.id, Buffer.from('late'), { epoch: 2 }).expect(409);
    expect(await prisma.fleetCommand.count({ where: { jobId: j.id, type: 'ABANDON' } })).toBe(1);
    expect((await download(j.id, 'dev').expect(200)).body).toEqual(good);
  });

  it.each(['lease', 'state'] as const)('rejects a %s change while the bundle body streams and preserves the prior bundle', async (change) => {
    const j = await job(`stream-${change}`, 'RUNNING');
    const good = Buffer.from('prior-bundle');
    await upload(j.id, good).expect(201);
    const prior = await prisma.fleetJobArtifact.findFirstOrThrow({ where: { jobId: j.id } });
    const body = Buffer.from('late-bundle');
    let started!: () => void;
    let resume!: () => void;
    const streaming = new Promise<void>((resolve) => { started = resolve; });
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    const stream = Readable.from((async function* () {
      yield body.subarray(0, 4);
      started();
      await resumed;
      yield body.subarray(4);
    })());
    const result = app.get(BundleService).upload({
      runnerId: runner.runnerId, jobId: j.id, leaseEpochRaw: '1', sha256Header: sha(body),
      contentType: 'application/gzip', contentLength: String(body.length), body: stream,
    }).then(() => null, (error: unknown) => error);
    await streaming;
    try {
      // Isolate a state-only race at the held epoch; normal terminal transitions also bump it.
      await prisma.fleetJob.update({ where: { id: j.id }, data: change === 'lease' ? { leaseEpoch: 2 } : { state: 'CANCELLED' } });
    } finally {
      resume();
    }
    const error = await result;
    expect(error).toBeInstanceOf(change === 'lease' ? FleetFenceException : ConflictAppException);
    expect((error as FleetFenceException).getStatus()).toBe(409);
    expect(await prisma.fleetCommand.count({ where: { jobId: j.id, runnerId: runner.runnerId, leaseEpoch: 1, type: 'ABANDON' } })).toBe(change === 'lease' ? 1 : 0);
    expect(await prisma.fleetJobArtifact.findFirstOrThrow({ where: { jobId: j.id } })).toEqual(prior);
    expect(await prisma.fleetActivity.count({ where: { jobId: j.id, action: 'job.bundle_uploaded' } })).toBe(1);
    expect(readdirSync(join(process.env.FLEET_ARTIFACT_DIR as string, 'jobs', j.id, '1'))).toEqual([prior.storageKey.split('/').pop()]);
    expect((await download(j.id, 'dev').expect(200)).body).toEqual(good);
  });
});

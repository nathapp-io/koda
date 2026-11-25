import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet S1 slice 2 — bundle upload (runner, fenced) and download (member), spec §3.3, §8.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-bundles.integration.spec.ts
 */
import request from 'supertest';
import { createHash } from 'crypto';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { readFile } from 'fs/promises';
import { TRANSACTION_MANAGER, type ITransactionManager, type TransactionRunOptions } from '@nathapp/nestjs-data';
import { ARTIFACT_STORE, type ArtifactStore } from '../../../src/fleet/artifacts/artifact-store';
import { FLEET_JOB_REPOSITORY, type IFleetJobRepository } from '../../../src/fleet/jobs/domain/fleet-job.domain';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { tarGz } from '../../helpers/tar-gz';
import { BundleService } from '../../../src/fleet/artifacts/bundle.service';
import { FleetFenceException } from '../../../src/fleet/artifacts/bundle.exceptions';
import { BundleIngestService } from '../../../src/fleet/ingest/bundle-ingest.service';
import { INGEST_PARSER_VERSION } from '../../../src/fleet/ingest/domain/bundle-ingest.domain';
import { ConflictAppException } from '../../../src/common/exceptions/conflict-app.exception';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
const ENV = ['FLEET_ARTIFACT_DIR', 'FLEET_BUNDLE_MAX_BYTES'] as const;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describeIntegration('fleet bundles (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  const saved: Record<string, string | undefined> = {};
  let artifactDir: string;

  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  };
  const within = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('bundle interleaving timed out')), 4_000);
      })]);
    } finally {
      clearTimeout(timer);
    }
  };
  const directUpload = (jobId: string, body: Buffer) =>
    withTestActor({ type: 'RUNNER', id: runner.runnerId }, () => app.get(BundleService).upload({
      runnerId: runner.runnerId, jobId, leaseEpochRaw: '1', sha256Header: sha(body),
      contentType: 'application/gzip', contentLength: String(body.length), body: Readable.from([body]),
    }));

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
    artifactDir = mkdtempSync(join(tmpdir(), 'koda-bundles-'));
    process.env.FLEET_ARTIFACT_DIR = artifactDir;
    process.env.FLEET_BUNDLE_MAX_BYTES = '4096';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'box-1');
  });
  afterAll(async () => {
    await app.close();
    rmSync(artifactDir, { recursive: true, force: true });
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
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
    // The upload route is the runner's own, so the service runs as the runner that streams the bundle.
    const result = withTestActor({ type: 'RUNNER', id: runner.runnerId }, () => app.get(BundleService).upload({
      runnerId: runner.runnerId, jobId: j.id, leaseEpochRaw: '1', sha256Header: sha(body),
      contentType: 'application/gzip', contentLength: String(body.length), body: stream,
    })).then(() => null, (error: unknown) => error);
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

  it.each([
    'AC-1: removes a replacement attempt after pre-record rollback',
    'AC-2: propagates the original pre-record transaction error',
    'AC-3: preserves the previous row and readable bytes after rollback',
  ])('%s', async (criterion) => {
    const j = await job(criterion.slice(0, 4), 'UPLOADING');
    const good = Buffer.from('previous good bundle');
    await upload(j.id, good).expect(201);
    const prior = await prisma.fleetJobArtifact.findFirstOrThrow({ where: { jobId: j.id } });
    const repo = app.get<IFleetJobRepository>(FLEET_JOB_REPOSITORY);
    const original = new Error('metadata failed before recording');
    const fault = vi.spyOn(repo, 'upsertArtifact').mockRejectedValueOnce(original);
    const reads = vi.spyOn(repo, 'findArtifact');
    try {
      await expect(directUpload(j.id, Buffer.from('replacement bytes'))).rejects.toBe(original);
      // A new read after rollback, not the old transaction's view of the prior pointer.
      expect(reads).toHaveBeenCalledTimes(2);
      expect(readdirSync(join(artifactDir, 'jobs', j.id, '1'))).toEqual([prior.storageKey.split('/').pop()]);
      expect(await prisma.fleetJobArtifact.findFirstOrThrow({ where: { jobId: j.id } })).toEqual(prior);
      expect(await readFile(join(artifactDir, prior.storageKey))).toEqual(good);
      expect((await download(j.id, 'dev').expect(200)).body).toEqual(good);
    } finally {
      fault.mockRestore();
      reads.mockRestore();
    }
  });

  it.each([
    'AC-4: verification waits on the recording connection with bytes present',
    'AC-5: preserves the original error after a lost-ack commit',
    'AC-6: serves the committed bundle after a lost-ack commit',
  ])('%s', async (criterion) => {
    const j = await job(criterion.slice(0, 4), 'UPLOADING');
    const body = Buffer.from('committed despite lost acknowledgement');
    const manager = app.get<ITransactionManager>(TRANSACTION_MANAGER);
    const run = manager.run.bind(manager);
    const recorded = deferred();
    const release = deferred();
    const verifying = deferred();
    const original = new Error('commit acknowledgement lost');
    let recordingPid = 0;
    let verificationPid = 0;
    let commit: Promise<unknown> | undefined;
    let calls = 0;
    const fault = vi.spyOn(manager, 'run').mockImplementation(async <T>(fn: () => Promise<T>, options?: TransactionRunOptions): Promise<T> => {
      const call = ++calls;
      if (call === 2) {
        // Leave the caller's transaction scope while its recording connection still holds the lock.
        // This models a transport failure before the server's COMMIT acknowledgement arrives.
        commit = run(async () => {
          const result = await fn();
          recordingPid = (await prisma.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid;
          recorded.resolve();
          await release.promise;
          return result;
        }, { timeout: 15_000 });
        void commit.catch(() => recorded.resolve());
        await recorded.promise;
        throw original;
      }
      if (call === 3) {
        return run(async () => {
          verificationPid = (await prisma.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid;
          verifying.resolve();
          return fn();
        }, options);
      }
      return run(fn, options);
    });
    let settled = false;
    const result = directUpload(j.id, body).then(() => null, (error: unknown) => error)
      .finally(() => { settled = true; });
    try {
      await within(verifying.promise);
      expect(verificationPid).not.toBe(recordingPid);
      // The observer is outside both transactions; identify the exact lock waiter and blocker.
      let waiters: Array<{ pid: number; wait: string; query: string; blockers: number[] }> = [];
      const deadline = Date.now() + 3_000;
      do {
        waiters = await prisma.$queryRaw`
          SELECT pid, wait_event_type AS wait, query, pg_blocking_pids(pid) AS blockers
          FROM pg_stat_activity WHERE pid = ${verificationPid}
          AND ${recordingPid} = ANY(pg_blocking_pids(pid))`;
        if (waiters.length) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      } while (Date.now() < deadline);
      expect(waiters).toHaveLength(1);
      expect(waiters[0]).toMatchObject({ pid: verificationPid, wait: 'Lock', blockers: [recordingPid] });
      expect(waiters[0].query).toMatch(/FleetJob.*FOR UPDATE/);
      expect(settled).toBe(false);
      const files = readdirSync(join(artifactDir, 'jobs', j.id, '1'));
      expect(files).toHaveLength(1);
      expect(await readFile(join(artifactDir, 'jobs', j.id, '1', files[0]))).toEqual(body);
      // The pointer is not visible to a primary observer until we let the recording tx commit.
      expect(await prisma.fleetJobArtifact.count({ where: { jobId: j.id } })).toBe(0);
      release.resolve();
      await commit;
      expect(await result).toBe(original);
      const pointer = await prisma.fleetJobArtifact.findFirstOrThrow({ where: { jobId: j.id } });
      expect(pointer.storageKey).toBe(`jobs/${j.id}/1/${files[0]}`);
      expect(await readFile(join(artifactDir, pointer.storageKey))).toEqual(body);
      expect((await download(j.id, 'dev').expect(200)).body).toEqual(body);
    } finally {
      release.resolve();
      try {
        await commit;
        await result;
      } finally {
        fault.mockRestore();
      }
    }
  });

  it.each([
    'AC-11: retries with a new durable key and readable bytes',
    'AC-12: delayed failed-attempt cleanup cannot delete the successful retry key',
  ])('%s', async (criterion) => {
    const j = await job(criterion.slice(0, 5), 'UPLOADING');
    const repo = app.get<IFleetJobRepository>(FLEET_JOB_REPOSITORY);
    const store = app.get<ArtifactStore>(ARTIFACT_STORE);
    const remove = store.delete.bind(store);
    const deleting = deferred();
    const release = deferred();
    let failedKey = '';
    const original = new Error('first attempt metadata failure');
    const fault = vi.spyOn(repo, 'upsertArtifact').mockRejectedValueOnce(original);
    const cleanup = vi.spyOn(store, 'delete').mockImplementation(async (key) => {
      if (!failedKey) {
        failedKey = key;
        deleting.resolve();
        await release.promise;
      }
      await remove(key);
    });
    const failed = directUpload(j.id, Buffer.from('failed bytes')).then(() => null, (error: unknown) => error);
    try {
      await within(deleting.promise);
      // Retry while reconciliation's deletion of its own orphan is paused.
      const body = Buffer.from('successful retry bytes');
      await upload(j.id, body).expect(201);
      const pointer = await prisma.fleetJobArtifact.findFirstOrThrow({ where: { jobId: j.id } });
      expect(pointer.storageKey).not.toBe(failedKey);
      expect(pointer.sha256).toBe(sha(body));
      expect(await readFile(join(artifactDir, pointer.storageKey))).toEqual(body);
      release.resolve();
      expect(await failed).toBe(original);
      expect(cleanup).toHaveBeenCalledExactlyOnceWith(failedKey);
      expect(await store.stat(failedKey)).toBeNull();
      expect(await readFile(join(artifactDir, pointer.storageKey))).toEqual(body);
      expect((await download(j.id, 'dev').expect(200)).body).toEqual(body);
    } finally {
      release.resolve();
      await failed;
      fault.mockRestore();
      cleanup.mockRestore();
    }
  });

  it('enqueues ingest in the upload transaction; a re-upload resets the same row (S2b §2.1, Review Focus 1)', async () => {
    const j = await job('ingest', 'UPLOADING');
    const gz = await tarGz([{ name: 'nax-out/cost/u.jsonl', body: JSON.stringify({ ts: 0, schemaVersion: 8, agentName: 'native', model: 'm', stage: 'run', featureName: 'f', callId: 'c1', tokens: {}, costUsd: 0.01 }) }]);
    await upload(j.id, gz).expect(201);
    const first = await prisma.fleetBundleIngest.findMany({ where: { jobId: j.id } });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ status: 'pending', leaseEpoch: 1, parserVersion: INGEST_PARSER_VERSION });
    await upload(j.id, gz).expect(201);
    const second = await prisma.fleetBundleIngest.findMany({ where: { jobId: j.id } });
    expect(second.map((r) => r.id)).toEqual([first[0].id]);
    await prisma.fleetJob.update({ where: { id: j.id }, data: { state: 'COMPLETED', finishedAt: new Date() } });
    // The ingest drain runs as its own component: production chains it off the upload's kick.
    await withTestActor({ type: 'SYSTEM', id: 'ingest' }, () => app.get(BundleIngestService).drain());
    expect(await prisma.fleetCostEvent.count({ where: { jobId: j.id } })).toBe(1);
  });
});

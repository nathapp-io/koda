import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { tarGz } from '../../helpers/tar-gz';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld, enrollRunner, FLEET_CAPS } from '../../helpers/fleet-fixtures';
import { fixtureDb } from '../../helpers/action-context';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
const ENV = ['FLEET_ARTIFACT_DIR', 'FLEET_BUNDLE_MAX_BYTES'] as const;
const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex');

describeIntegration('audit runner enrollment and bundle upload (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  let recorder: AuditRecorder;
  const saved: Record<string, string | undefined> = {};
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const enrollBody = (token: string, name: string) => ({ enrollmentToken: token, name, os: 'linux', arch: 'x64', daemonVersion: '0.1.0', protocolVersion: 1, bootId: 'boot-1', labels: [], capabilities: FLEET_CAPS });
  const createEnrollment = async () => data<{ id: string; token: string }>(await request(server).post('/api/fleet/enrollments').set(auth(world.tokens.root)).send({ labels: [] }).expect(201));
  const enroll = (body: object) => request(server).post('/api/fleet/runner/enroll').send(body);
  const job = (feature: string, state = 'RUNNING', epoch = 1) => prisma.fleetJob.create({ data: {
    projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature, profiles: [], selectorLabels: [],
    maxCostUsd: new Prisma.Decimal(1), requestedById: world.ids.dev, state, runnerId: runner.runnerId, leaseEpoch: epoch,
  } });
  const upload = (jobId: string, body: Buffer, epoch = 1) => request(server).put(`/api/fleet/runner/jobs/${jobId}/bundle?leaseEpoch=${epoch}`)
    .set({ ...auth(runner.apiKey), 'content-type': 'application/gzip', 'x-content-sha256': sha(body) }).send(body);
  const bundleEntries = (jobId: string) => prisma.auditEntry.findMany({ where: { key: 'runner.bundle.upload', resourceId: jobId } });
  const runnerActorEntries = () => prisma.auditEntry.count({ where: { actorId: runner.runnerId } });

  beforeAll(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env.FLEET_ARTIFACT_DIR = mkdtempSync(join(tmpdir(), 'koda-audit-bundle-'));
    process.env.FLEET_BUNDLE_MAX_BYTES = '4096';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    recorder = app.get(AuditRecorder);
    runner = await enrollRunner(server, world.tokens.root, 'audit-enroll-runner');
  });
  afterAll(async () => {
    await app.close();
    for (const k of ENV) {
      const value = saved[k];
      if (value === undefined) delete process.env[k];
      else process.env[k] = value;
    }
  });

  it('AC-1: attributes enrollment to the created runner', async () => {
    const enrollment = await createEnrollment();
    const result = data<{ runnerId: string }>(await enroll(enrollBody(enrollment.token, 'audit-exact-runner')).expect(201));
    const rows = await prisma.auditEntry.findMany({ where: { key: 'runner.enroll', resourceId: result.runnerId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ key: 'runner.enroll', resourceType: 'fleet-runner', resourceId: result.runnerId,
      projectId: null, actorType: 'RUNNER', actorId: result.runnerId, origin: 'runner', summary: `enrolled from enrollment ${enrollment.id}` }));
  });

  it('AC-2: used token rejection leaves total runner.enroll entries unchanged', async () => {
    const enrollment = await createEnrollment();
    await enroll(enrollBody(enrollment.token, 'audit-once')).expect(201);
    const before = await prisma.auditEntry.count({ where: { key: 'runner.enroll' } });
    await enroll(enrollBody(enrollment.token, 'audit-used')).expect(401);
    expect(await prisma.auditEntry.count({ where: { key: 'runner.enroll' } })).toBe(before);
  });

  it('AC-3: name conflict leaves token usable and creates no entry until successful retry', async () => {
    const enrollment = await createEnrollment();
    const before = await prisma.auditEntry.count({ where: { key: 'runner.enroll' } });
    await enroll(enrollBody(enrollment.token, 'audit-enroll-runner')).expect(409);
    expect(await prisma.auditEntry.count({ where: { key: 'runner.enroll' } })).toBe(before);
    await enroll(enrollBody(enrollment.token, 'audit-free-name')).expect(201);
    expect(await prisma.auditEntry.count({ where: { key: 'runner.enroll' } })).toBe(before + 1);
  });

  it('AC-4: rejected enrollment audit rolls back runner and token consumption', async () => {
    const enrollment = await createEnrollment();
    const before = await prisma.runner.count();
    const record = vi.spyOn(recorder, 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    await enroll(enrollBody(enrollment.token, 'audit-rollback')).expect(500);
    expect(await prisma.runner.count()).toBe(before);
    expect((await prisma.runnerEnrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).usedAt).toBeNull();
    record.mockRestore();
  });

  it('AC-5/6: records first bundle and replacement summaries for the runner', async () => {
    const j = await job('audit-first-upload');
    const firstBundle = await tarGz([{ name: 'nax-out/run/result.json', body: '{"ok":true}' }]);
    const replacementBundle = await tarGz([{ name: 'nax-out/run/replacement.json', body: '{"ok":true}' }]);
    expect(gunzipSync(firstBundle).length).toBeGreaterThan(0);
    expect(gunzipSync(replacementBundle).length).toBeGreaterThan(0);
    await upload(j.id, firstBundle).expect(201);
    await upload(j.id, replacementBundle).expect(201);
    const entries = await bundleEntries(j.id);
    expect(entries.map((entry) => entry.summary)).toEqual(['bundle uploaded at epoch 1', 'bundle replaced at epoch 1']);
    expect(entries[0]).toEqual(expect.objectContaining({ resourceType: 'fleet-job', projectId: world.projectId, actorType: 'RUNNER', actorId: runner.runnerId, origin: 'runner' }));
  });

  it('AC-7/8: stale lease and completed job return 409 without bundle audit entries', async () => {
    const stale = await job('audit-stale', 'RUNNING', 2);
    await upload(stale.id, Buffer.from('stale'), 1).expect(409);
    expect(await prisma.fleetCommand.count({ where: { jobId: stale.id, runnerId: runner.runnerId, type: 'ABANDON' } })).toBe(1);
    expect(await bundleEntries(stale.id)).toHaveLength(0);
    const completed = await job('audit-completed', 'COMPLETED');
    await upload(completed.id, Buffer.from('completed')).expect(409);
    expect(await bundleEntries(completed.id)).toHaveLength(0);
  });

  it('AC-9: rejected bundle audit rolls back artifact and ingest rows', async () => {
    const j = await job('audit-bundle-rollback');
    const record = vi.spyOn(recorder, 'record').mockImplementation(async (input) => {
      if (input.key === 'runner.bundle.upload') throw new Error('audit unavailable');
    });
    await upload(j.id, Buffer.from('rollback')).expect(500);
    expect(await prisma.fleetJobArtifact.findMany({ where: { jobId: j.id } })).toEqual([]);
    expect(await prisma.fleetBundleIngest.findMany({ where: { jobId: j.id } })).toEqual([]);
    record.mockRestore();
  });

  it('AC-10/11: log upload and runner/me do not add runner audit entries', async () => {
    const before = await runnerActorEntries();
    const logBody = Buffer.from('log chunk');
    await request(server).put(`/api/fleet/runner/jobs/${(await job('audit-log-no-entry')).id}/logs/stdout?leaseEpoch=1&offset=0`)
      .set({ ...auth(runner.apiKey), 'content-type': 'application/octet-stream', 'x-content-sha256': sha(logBody) }).send(logBody).expect(200);
    await request(server).get('/api/fleet/runner/me').set(auth(runner.apiKey)).expect(200);
    expect(await runnerActorEntries()).toBe(before);
  });

  it('AC-13: wrong and expired enrollment tokens return 401 without audit entries', async () => {
    const enrollment = await createEnrollment();
    const before = await prisma.auditEntry.count({ where: { key: 'runner.enroll' } });
    await enroll(enrollBody(`ke_${'0'.repeat(64)}`, 'audit-wrong-token')).expect(401);
    await prisma.runnerEnrollment.update({ where: { id: enrollment.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await enroll(enrollBody(enrollment.token, 'audit-expired-token')).expect(401);
    expect(await prisma.auditEntry.count({ where: { key: 'runner.enroll' } })).toBe(before);
  });
});

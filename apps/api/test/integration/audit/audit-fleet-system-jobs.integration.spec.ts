import { canRunDbTests } from '../../helpers/test-environment';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { tarGz } from '../../helpers/tar-gz';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { insertRunner, seedFleetBase } from '../../helpers/fleet-fixtures';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { FleetSweeper } from '../../../src/fleet/sync/fleet-sweeper';
import { PlacementService } from '../../../src/fleet/jobs/placement.service';
import { BundleIngestService } from '../../../src/fleet/ingest/bundle-ingest.service';
import { ARTIFACT_STORE, ArtifactStore } from '../../../src/fleet/artifacts/artifact-store';
import { BUNDLE_INGEST_REPOSITORY, IBundleIngestRepository } from '../../../src/fleet/ingest/domain/bundle-ingest.domain';

const describeDb = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

describeDb('system fleet job audit writes (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let base: Awaited<ReturnType<typeof seedFleetBase>>;
  let runnerId: string;
  let n = 0;
  const now = new Date('2026-10-01T12:00:00.000Z');
  const job = (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: { projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature: `audit-system-${++n}`, profiles: [], selectorLabels: [], maxCostUsd: new Prisma.Decimal(5), requestedById: base.adminId, ...over },
  });
  const auditRows = (id: string, key: string) => prisma.auditEntry.findMany({ where: { resourceType: 'fleet-job', resourceId: id, key } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    base = await seedFleetBase(prisma);
    runnerId = (await insertRunner(prisma, { lastSeenAt: new Date(now.getTime() - 301_000) })).id;
  });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => {
    await prisma.auditEntry.deleteMany();
    await prisma.budgetPolicy.deleteMany();
    await prisma.fleetBundleIngest.deleteMany();
    await prisma.fleetJobArtifact.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.fleetCommand.deleteMany();
    await prisma.runner.deleteMany();
    runnerId = (await insertRunner(prisma, { lastSeenAt: new Date(now.getTime() - 301_000) })).id;
  });

  it('AC-1/2: records silent runner crash once with SYSTEM/job attribution', async () => {
    const running = await job({ state: 'RUNNING', runnerId, leaseEpoch: 1 });
    const sweeper = app.get(FleetSweeper);
    expect(await sweeper.sweep(now)).toBe(1);
    const rows = await auditRows(running.id, 'system.job.crash-silent-runner');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: 'SYSTEM', actorId: 'job', origin: 'system', summary: 'RUNNING -> CRASHED', projectId: base.projectId });
    expect(await sweeper.sweep(now)).toBe(0);
    expect(await auditRows(running.id, 'system.job.crash-silent-runner')).toHaveLength(1);
  });

  it('AC-3: skips a runner seen within the crash cutoff without an audit row', async () => {
    const alive = await insertRunner(prisma, { lastSeenAt: new Date(now.getTime() - 10_000) });
    const running = await job({ state: 'RUNNING', runnerId: alive.id, leaseEpoch: 1 });
    expect(await app.get(FleetSweeper).sweep(now)).toBe(0);
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: running.id } })).state).toBe('RUNNING');
    expect(await auditRows(running.id, 'system.job.crash-silent-runner')).toHaveLength(0);
  });

  it('AC-4: rolls back a silent-runner transition when audit recording rejects', async () => {
    const running = await job({ state: 'RUNNING', runnerId, leaseEpoch: 1 });
    const record = vi.spyOn(app.get(AuditRecorder), 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(app.get(FleetSweeper).sweep(now)).rejects.toThrow('audit unavailable');
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: running.id } })).state).toBe('RUNNING');
    record.mockRestore();
  });

  it('AC-5/11: records paused-budget cancellation as SYSTEM/budget and rolls it back on audit failure', async () => {
    const runner = await insertRunner(prisma, { capacity: 1 });
    const queued = await job({ state: 'QUEUED' });
    const policy = await prisma.budgetPolicy.create({ data: {
      scopeType: 'project', scopeId: base.projectId, scopeKey: `project:${base.projectId}`, projectId: base.projectId,
      windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(10), createdById: base.adminId, updatedById: base.adminId,
      pausedAt: now, pausedWindowStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    } });
    const placement = app.get(PlacementService);
    await withTestActor({ type: 'RUNNER', id: runner.id }, () => placement.fillRunner(runner.id, 1, now));
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: queued.id } })).state).toBe('CANCELLED');
    const [entry] = await auditRows(queued.id, 'system.budget.window-reset');
    expect(entry).toMatchObject({ actorType: 'SYSTEM', actorId: 'budget', summary: `QUEUED -> CANCELLED: budget ${policy.id} paused`, origin: 'system' });

    const second = await job({ state: 'QUEUED' });
    const record = vi.spyOn(app.get(AuditRecorder), 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(withTestActor({ type: 'RUNNER', id: runner.id }, () => placement.fillRunner(runner.id, 1, now))).rejects.toThrow('audit unavailable');
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: second.id } })).state).toBe('QUEUED');
    record.mockRestore();
  });

  it('AC-6: placement assignment is not audited', async () => {
    const runner = await insertRunner(prisma, { capacity: 1 });
    const queued = await job({ state: 'QUEUED' });
    await withTestActor({ type: 'RUNNER', id: runner.id }, () => app.get(PlacementService).fillRunner(runner.id, 1, now));
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: queued.id } })).state).toBe('ASSIGNED');
    expect(await auditRows(queued.id, 'system.budget.window-reset')).toHaveLength(0);
  });

  it('AC-8/9: no claim and expired artifacts create no ingest audit entry', async () => {
    const ingest = app.get(BundleIngestService);
    expect(await ingest.drain(now)).toBe(0);
    const expiredJob = await job({ state: 'COMPLETED', leaseEpoch: 1, finishedAt: now });
    const artifact = await prisma.fleetJobArtifact.create({ data: {
      jobId: expiredJob.id, leaseEpoch: 1, kind: 'bundle', storageKey: 'expired.tar.gz', sizeBytes: 1n, sha256: 'a'.repeat(64), expiredAt: now,
    } });
    const repository = app.get<IBundleIngestRepository>(BUNDLE_INGEST_REPOSITORY);
    await withTestActor({ type: 'SYSTEM', id: 'ingest' }, () => repository.enqueue(artifact.id, expiredJob.id, 1, 1));
    expect(await withTestActor({ type: 'SYSTEM', id: 'ingest' }, () => ingest.drain(now))).toBe(1);
    expect(await prisma.fleetBundleIngest.findFirstOrThrow({ where: { jobId: expiredJob.id } })).toMatchObject({ status: 'failed' });
    expect(await auditRows(expiredJob.id, 'system.ingest.drain')).toHaveLength(0);
  });

  it('AC-7/10: records completed ingest once; audit failure rolls back writes and retries', async () => {
    const store = app.get<ArtifactStore>(ARTIFACT_STORE);
    const repository = app.get<IBundleIngestRepository>(BUNDLE_INGEST_REPOSITORY);
    const bundle = await tarGz([{ name: 'nax-out/status.json', body: JSON.stringify({ run: { id: 'run-a', status: 'completed' } }) }]);
    const sha256 = createHash('sha256').update(bundle).digest('hex');
    const enqueueBundle = async (jobId: string) => {
      const key = `jobs/${jobId}/1/${sha256.slice(0, 8)}.tar.gz`;
      await store.put(key, Readable.from([bundle]), { maxBytes: 10_000_000, expectedSha256: sha256 });
      const artifact = await prisma.fleetJobArtifact.create({ data: {
        jobId, leaseEpoch: 1, kind: 'bundle', storageKey: key, sizeBytes: BigInt(bundle.length), sha256,
      } });
      await withTestActor({ type: 'SYSTEM', id: 'ingest' }, () => repository.enqueue(artifact.id, jobId, 1, 1));
      return artifact;
    };

    const completed = await job({ state: 'COMPLETED', leaseEpoch: 1, finishedAt: now, naxRunId: 'run-a' });
    await enqueueBundle(completed.id);
    expect(await withTestActor({ type: 'SYSTEM', id: 'ingest' }, () => app.get(BundleIngestService).drain(now))).toBe(1);
    const [success] = await auditRows(completed.id, 'system.ingest.drain');
    expect(success).toMatchObject({ actorType: 'SYSTEM', actorId: 'ingest', origin: 'system', resourceType: 'fleet-job', projectId: base.projectId, summary: expect.stringMatching(/^ingested (done|partial)$/) });

    const retryJob = await job({ state: 'COMPLETED', leaseEpoch: 1, finishedAt: now });
    await enqueueBundle(retryJob.id);
    const record = vi.spyOn(app.get(AuditRecorder), 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    expect(await withTestActor({ type: 'SYSTEM', id: 'ingest' }, () => app.get(BundleIngestService).drain(now))).toBe(1);
    record.mockRestore();
    const ingestRow = await prisma.fleetBundleIngest.findFirstOrThrow({ where: { jobId: retryJob.id } });
    expect(ingestRow).toMatchObject({ status: 'pending', attempts: 1 });
    expect(await prisma.fleetCostEvent.count({ where: { jobId: retryJob.id } })).toBe(0);
    expect(await auditRows(retryJob.id, 'system.ingest.drain')).toHaveLength(0);
  });
});

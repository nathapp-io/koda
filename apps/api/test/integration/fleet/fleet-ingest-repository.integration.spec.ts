/**
 * Fleet S2b slice 1a — ingest repository (PG), spec §2.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-ingest-repository.integration.spec.ts
 */
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { resetDb } from '../../helpers/reset-db';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import { PrismaBundleIngestRepository } from '../../../src/fleet/ingest/prisma-bundle-ingest.repository';
import { createTestPrismaClient } from '../../helpers/test-prisma';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('bundle ingest repository (PG)', () => {
  const prisma = createTestPrismaClient();
  const repo = new PrismaBundleIngestRepository({ client: prisma } as unknown as PrismaService<PrismaClient>);
  let base: Awaited<ReturnType<typeof seedFleetBase>>;
  const now = new Date('2026-10-05T10:00:00Z');

  const jobWithBundle = async (state: string, epoch = 1) => {
    const job = await prisma.fleetJob.create({
      data: {
        projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature: 'f', profiles: [], selectorLabels: [],
        maxCostUsd: new Prisma.Decimal(1), requestedById: base.adminId, state, leaseEpoch: epoch,
      },
    });
    const artifact = await prisma.fleetJobArtifact.create({
      data: { jobId: job.id, leaseEpoch: epoch, kind: 'bundle', storageKey: `jobs/${job.id}/${epoch}/a.tar.gz`, sizeBytes: BigInt(1), sha256: 'a'.repeat(64) },
    });
    return { jobId: job.id, artifactId: artifact.id };
  };

  beforeAll(async () => {
    await resetDb();
    base = await seedFleetBase(prisma);
  });
  beforeEach(async () => {
    await prisma.fleetBundleIngest.deleteMany();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('enqueue inserts, and a second enqueue resets the same row (Review Focus 1)', async () => {
    const { jobId, artifactId } = await jobWithBundle('COMPLETED');
    await repo.enqueue(artifactId, jobId, 1, 1);
    await prisma.fleetBundleIngest.update({ where: { artifactId }, data: { status: 'done', attempts: 2 } });
    await repo.enqueue(artifactId, jobId, 1, 1);
    const rows = await prisma.fleetBundleIngest.findMany({ where: { artifactId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 0, nextAttemptAt: null });
  });

  it('claims only rows whose job is terminal, oldest first', async () => {
    const running = await jobWithBundle('UPLOADING');
    const done = await jobWithBundle('COMPLETED');
    await repo.enqueue(running.artifactId, running.jobId, 1, 1);
    await repo.enqueue(done.artifactId, done.jobId, 1, 1);
    const claim = await repo.claimNext(now);
    expect(claim).toMatchObject({ jobId: done.jobId, leaseEpoch: 1, attempts: 0 });
    expect(await repo.claimNext(now)).toBeNull();
    expect((await prisma.fleetBundleIngest.findUniqueOrThrow({ where: { artifactId: done.artifactId } })).status).toBe('running');
  });

  it('skips a pending row whose backoff is not due', async () => {
    const a = await jobWithBundle('FAILED');
    await repo.enqueue(a.artifactId, a.jobId, 1, 1);
    const row = await prisma.fleetBundleIngest.findUniqueOrThrow({ where: { artifactId: a.artifactId } });
    await repo.markRetry(row.id, 1, new Date(now.getTime() + 60_000), 'boom');
    expect(await repo.claimNext(now)).toBeNull();
    expect(await repo.claimNext(new Date(now.getTime() + 60_000))).toMatchObject({ attempts: 1 });
  });

  it('re-claims a running row whose claim is older than 10 minutes (Review Focus 5)', async () => {
    const a = await jobWithBundle('COMPLETED');
    await repo.enqueue(a.artifactId, a.jobId, 1, 1);
    expect(await repo.claimNext(now)).not.toBeNull();
    expect(await repo.claimNext(new Date(now.getTime() + 599_000))).toBeNull();
    expect(await repo.claimNext(new Date(now.getTime() + 600_001))).toMatchObject({ jobId: a.jobId });
  });

  it('replaceRows deletes then inserts one attempt', async () => {
    const a = await jobWithBundle('COMPLETED');
    const ctx = { jobId: a.jobId, leaseEpoch: 1, projectId: base.projectId, repoId: base.repoId, runnerId: null, naxRunId: 'run-1' };
    const cost = (callId: string) => ({
      at: new Date(0), agentName: 'native', model: 'm', modelTier: null, profile: null, stage: 'run', sessionRole: null, featureName: 'f',
      storyId: null, callId, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: '0.5', pricingSource: null, confidence: null, durationMs: null,
    });
    await repo.replaceRows(ctx, { costEvents: [cost('a'), cost('b')], stories: [], reviews: [] });
    await repo.replaceRows(ctx, { costEvents: [cost('a')], stories: [], reviews: [] });
    expect(await prisma.fleetCostEvent.count({ where: { jobId: a.jobId } })).toBe(1);
    expect((await prisma.fleetCostEvent.findFirstOrThrow({ where: { jobId: a.jobId } })).projectId).toBe(base.projectId);
  });

  it('backfill enqueues unexpired artifacts without a row; rerun and rerunOutdated reset', async () => {
    const a = await jobWithBundle('COMPLETED');
    const b = await jobWithBundle('COMPLETED');
    await prisma.fleetJobArtifact.update({ where: { id: b.artifactId }, data: { expiredAt: now } });
    expect(await repo.backfill(1)).toBeGreaterThanOrEqual(1);
    expect(await prisma.fleetBundleIngest.count({ where: { artifactId: b.artifactId } })).toBe(0);
    const row = await prisma.fleetBundleIngest.findUniqueOrThrow({ where: { artifactId: a.artifactId } });
    await repo.markFailed(row.id, 5, 'bad');
    expect(await repo.rerunJob(a.jobId)).toBe(1);
    expect(await prisma.fleetBundleIngest.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'pending', attempts: 0, error: null });
    await prisma.fleetBundleIngest.update({ where: { id: row.id }, data: { status: 'done', parserVersion: 1 } });
    expect(await repo.rerunOutdated(2)).toBe(1);
    expect(await repo.rerunOutdated(1)).toBe(0);
  });

  it('pages rows filtered by status with the job project', async () => {
    const a = await jobWithBundle('COMPLETED');
    await repo.enqueue(a.artifactId, a.jobId, 1, 1);
    const page = await repo.findPage({ status: 'pending' }, { current: 1, size: 10 } as never);
    expect(page.records.some((r) => r.jobId === a.jobId && r.projectId === base.projectId && r.status === 'pending')).toBe(true);
  });
});

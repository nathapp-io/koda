/**
 * Fleet S2b slice 1a — ingest tables (PG), spec §1.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-ingest-schema.integration.spec.ts
 */
import { Prisma } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { createTestPrismaClient } from '../../helpers/test-prisma';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet ingest schema (PG)', () => {
  const prisma = createTestPrismaClient();
  let jobId: string;
  let artifactId: string;
  let projectId: string;
  let repoId: string;

  beforeAll(async () => {
    await resetDb();
    const user = await prisma.user.create({ data: { email: 'u@koda.test', passwordHash: 'x', role: 'ADMIN' } });
    const project = await prisma.project.create({ data: { name: 'P', slug: 'p', key: 'P' } });
    const repo = await prisma.fleetRepo.create({
      data: { projectId: project.id, provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', createdById: user.id },
    });
    const job = await prisma.fleetJob.create({
      data: {
        projectId: project.id, repoId: repo.id, ref: 'main', command: 'RUN', feature: 'f', profiles: [],
        maxCostUsd: new Prisma.Decimal('1'), selectorLabels: [], requestedById: user.id, state: 'COMPLETED',
      },
    });
    const artifact = await prisma.fleetJobArtifact.create({
      data: { jobId: job.id, leaseEpoch: 1, kind: 'bundle', storageKey: 'jobs/x/1/a.tar.gz', sizeBytes: BigInt(3), sha256: 'a'.repeat(64) },
    });
    jobId = job.id;
    artifactId = artifact.id;
    projectId = project.id;
    repoId = repo.id;
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const cost = (callId: string) => ({
    jobId, leaseEpoch: 1, projectId, repoId, runnerId: null, naxRunId: 'run-1', at: new Date(0), agentName: 'native',
    model: 'm', modelTier: null, profile: null, stage: 'run', sessionRole: 'implementer', featureName: 'f', storyId: 'US-001',
    callId, inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: new Prisma.Decimal('0.00157927'),
    pricingSource: null, confidence: null, durationMs: null,
  });

  it('keeps 8 decimal places on a cost event and rejects a duplicate call id per attempt', async () => {
    await prisma.fleetCostEvent.create({ data: cost('c1') });
    const row = await prisma.fleetCostEvent.findUniqueOrThrow({ where: { jobId_leaseEpoch_callId: { jobId, leaseEpoch: 1, callId: 'c1' } } });
    expect(row.costUsd.toString()).toBe('0.00157927');
    await expect(prisma.fleetCostEvent.create({ data: cost('c1') })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows one ingest row per artifact with defaults', async () => {
    const row = await prisma.fleetBundleIngest.create({ data: { artifactId, jobId, leaseEpoch: 1, parserVersion: 1 } });
    expect(row).toMatchObject({ status: 'pending', attempts: 0, files: {}, nextAttemptAt: null, claimedAt: null });
    await expect(prisma.fleetBundleIngest.create({ data: { artifactId, jobId, leaseEpoch: 1, parserVersion: 1 } })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('cascades every ingest table with the job', async () => {
    await prisma.fleetStoryResult.create({
      data: {
        jobId, leaseEpoch: 1, projectId, repoId, featureName: 'f', storyId: 'US-001', attempts: 1, success: true, firstPassSuccess: true,
        costUsd: new Prisma.Decimal('0.1'), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      },
    });
    await prisma.fleetReviewResult.create({
      data: { jobId, leaseEpoch: 1, projectId, storyId: 'US-001', reviewer: 'semantic', recordId: 'r1', passed: true, failOpen: false, findingCount: 0, findingsBySeverity: {}, advisoryCount: 0, at: new Date(0) },
    });
    await prisma.fleetJob.delete({ where: { id: jobId } });
    expect(await prisma.fleetCostEvent.count()).toBe(0);
    expect(await prisma.fleetStoryResult.count()).toBe(0);
    expect(await prisma.fleetReviewResult.count()).toBe(0);
    expect(await prisma.fleetBundleIngest.count()).toBe(0);
  });
});

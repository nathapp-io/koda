/**
 * Fleet S2a slice 1a — FleetJobLog table and repository (PG), spec §1.2.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-job-logs-schema.integration.spec.ts
 */
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { resetDb } from '../../helpers/reset-db';
import { PrismaFleetJobLogRepository } from '../../../src/fleet/logs/prisma-fleet-job-log.repository';
import { createTestPrismaClient } from '../../helpers/test-prisma';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet job logs schema (PG)', () => {
  const prisma = createTestPrismaClient();
  const repo = new PrismaFleetJobLogRepository({ client: prisma } as unknown as PrismaService<PrismaClient>);
  let jobId: string;

  beforeAll(async () => {
    await resetDb();
    const user = await prisma.user.create({ data: { email: 'u@koda.test', passwordHash: 'x', role: 'ADMIN' } });
    const project = await prisma.project.create({ data: { name: 'P', slug: 'p', key: 'P' } });
    const repoRow = await prisma.fleetRepo.create({
      data: { projectId: project.id, provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', createdById: user.id },
    });
    const job = await prisma.fleetJob.create({
      data: {
        projectId: project.id, repoId: repoRow.id, ref: 'main', command: 'RUN', feature: 'f', profiles: [],
        maxCostUsd: new Prisma.Decimal('1'), selectorLabels: [], requestedById: user.id, state: 'RUNNING',
      },
    });
    jobId = job.id;
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('upserts one row per (job, epoch, stream) and returns sizes as numbers', async () => {
    const created = await repo.upsertStream(jobId, 1, 'run', { sizeBytes: 10 });
    expect(created).toMatchObject({ jobId, leaseEpoch: 1, stream: 'run', sizeBytes: 10, complete: false, truncated: false, source: 'stream', expiredAt: null });
    const grown = await repo.upsertStream(jobId, 1, 'run', { sizeBytes: 20, complete: true });
    expect(grown).toMatchObject({ id: created.id, sizeBytes: 20, complete: true });
    await repo.upsertStream(jobId, 1, 'stdout', { sizeBytes: 5 });
    expect((await repo.listForAttempt(jobId, 1)).map((r) => r.stream).sort()).toEqual(['run', 'stdout']);
    expect(await repo.findStream(jobId, 2, 'run')).toBeNull();
  });

  it('completeFromBundle is a compare-and-set on complete = false and truncated = false', async () => {
    await repo.upsertStream(jobId, 3, 'stderr', { sizeBytes: 4 });
    expect(await repo.completeFromBundle(jobId, 3, 'stderr', { sizeBytes: 9, truncated: false })).toBe(true);
    expect(await repo.findStream(jobId, 3, 'stderr')).toMatchObject({ sizeBytes: 9, complete: true, source: 'bundle' });
    expect(await repo.completeFromBundle(jobId, 3, 'stderr', { sizeBytes: 12, truncated: false })).toBe(false);
    expect(await repo.completeFromBundle(jobId, 3, 'run', { sizeBytes: 7, truncated: true })).toBe(true); // no row yet: created
    expect(await repo.findStream(jobId, 3, 'run')).toMatchObject({ sizeBytes: 7, complete: false, truncated: true, source: 'bundle' });
  });

  it('rejects a duplicate (job, epoch, stream) row and cascades on job delete', async () => {
    await expect(prisma.fleetJobLog.create({ data: { jobId, leaseEpoch: 1, stream: 'run' } })).rejects.toMatchObject({ code: 'P2002' });
    const artifact = await prisma.fleetJobArtifact.create({ data: { jobId, leaseEpoch: 1, kind: 'bundle', storageKey: 'k', sizeBytes: 1n, sha256: 'x' } });
    expect(artifact.expiredAt).toBeNull();
    await prisma.fleetJob.delete({ where: { id: jobId } });
    expect(await prisma.fleetJobLog.count({ where: { jobId } })).toBe(0);
  });
});

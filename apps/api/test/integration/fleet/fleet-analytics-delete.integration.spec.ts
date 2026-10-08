/**
 * Fleet S2b slice 1b — analytics delete-on-demand (PG), spec §4.3, D384.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-analytics-delete.integration.spec.ts
 */
import { PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { resetDb } from '../../helpers/reset-db';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import {
  insertAnalyticsJob, insertCostEvent, insertIngestRow, insertReviewResult, insertStoryResult,
} from '../../helpers/fleet-analytics-fixtures';
import { PrismaAnalyticsRepository } from '../../../src/fleet/analytics/prisma-analytics.repository';
import { createTestPrismaClient } from '../../helpers/test-prisma';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('analytics delete-on-demand (PG)', () => {
  const prisma = createTestPrismaClient();
  const repo = new PrismaAnalyticsRepository({ client: prisma } as unknown as PrismaService<PrismaClient>);
  const cutoff = new Date('2026-10-05T00:00:00Z');
  const now = new Date('2026-10-06T00:00:00Z');
  let a: Awaited<ReturnType<typeof seedFleetBase>>;
  let b: Awaited<ReturnType<typeof seedFleetBase>>;
  let oldA: string;
  let newA: string;

  beforeAll(async () => {
    await resetDb();
    a = await seedFleetBase(prisma);
    b = await seedFleetBase(prisma);
    const ownerA = { projectId: a.projectId, repoId: a.repoId, requestedById: a.adminId };
    oldA = await insertAnalyticsJob(prisma, ownerA, { finishedAt: new Date('2026-10-02T00:00:00Z') });
    newA = await insertAnalyticsJob(prisma, ownerA, { finishedAt: new Date('2026-10-07T00:00:00Z') });
    const jobB = await insertAnalyticsJob(prisma, { projectId: b.projectId, repoId: b.repoId, requestedById: b.adminId }, { finishedAt: new Date('2026-10-02T00:00:00Z') });
    const rowOld = { jobId: oldA, projectId: a.projectId, repoId: a.repoId };
    const rowNew = { jobId: newA, projectId: a.projectId, repoId: a.repoId };
    const rowB = { jobId: jobB, projectId: b.projectId, repoId: b.repoId };
    await insertCostEvent(prisma, rowOld, { at: new Date('2026-10-01T00:00:00Z') });
    await insertCostEvent(prisma, rowNew, { at: new Date('2026-10-06T00:00:00Z') });
    await insertCostEvent(prisma, rowB, { at: new Date('2026-10-01T00:00:00Z') });
    await insertStoryResult(prisma, rowOld, { completedAt: new Date('2026-10-01T00:00:00Z') });
    await insertStoryResult(prisma, rowOld, { completedAt: null }); // matched through the job's finishedAt
    await insertStoryResult(prisma, rowNew, { completedAt: null });
    await insertReviewResult(prisma, rowOld, { at: new Date('2026-10-01T00:00:00Z') });
    await insertIngestRow(prisma, oldA, 1);
    await insertIngestRow(prisma, newA, 1);
    await insertIngestRow(prisma, jobB, 1);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  // These tests share state and run in order: run the file whole, never with `-t`.
  it('finds a project slug, null for an unknown id', async () => {
    expect(await repo.findProjectSlug(a.projectId)).toBe(a.projectSlug);
    expect(await repo.findProjectSlug('nope')).toBeNull();
  });

  it('deletes one project before the cutoff and marks the affected ingest rows', async () => {
    expect(await repo.deleteRows({ projectId: a.projectId, before: cutoff, now })).toEqual({ costEvents: 1, stories: 2, reviews: 1, ingestRowsMarked: 1 });
    expect(await prisma.fleetCostEvent.count({ where: { projectId: a.projectId } })).toBe(1);
    expect(await prisma.fleetCostEvent.count({ where: { projectId: b.projectId } })).toBe(1);
    expect(await prisma.fleetStoryResult.count({ where: { jobId: newA } })).toBe(1);
    const marked = await prisma.fleetBundleIngest.findFirstOrThrow({ where: { jobId: oldA } });
    expect(marked.files).toEqual({ cost: 'done:v8', deleted: '2026-10-05T00:00:00.000Z' });
    expect((await prisma.fleetBundleIngest.findFirstOrThrow({ where: { jobId: newA } })).files).toEqual({ cost: 'done:v8' });
    expect(await prisma.fleetBundleIngest.count()).toBe(3);
  });

  it('deletes across every project when projectId is null', async () => {
    expect(await repo.deleteRows({ projectId: null, before: new Date('2026-10-08T00:00:00Z'), now })).toEqual({
      costEvents: 2, stories: 1, reviews: 0, ingestRowsMarked: 2,
    });
    expect(await prisma.fleetCostEvent.count()).toBe(0);
  });
});

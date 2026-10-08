/**
 * Fleet S3 D479 — analytics job panels ignore config jobs (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-analytics-config-jobs.integration.spec.ts
 */
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import { insertAnalyticsJob } from '../../helpers/fleet-analytics-fixtures';
import { PrismaAnalyticsRepository } from '../../../src/fleet/analytics/prisma-analytics.repository';
import { createTestPrismaClient } from '../../helpers/test-prisma';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet analytics excludes config jobs (PG)', () => {
  const prisma = createTestPrismaClient();
  const repo = new PrismaAnalyticsRepository({ client: prisma } as unknown as PrismaService<PrismaClient>);
  const from = new Date('2026-09-28T00:00:00Z');
  const to = new Date('2026-10-12T00:00:00Z');
  let projectId: string;
  let runJob: string;

  beforeAll(async () => {
    await resetDb();
    const base = await seedFleetBase(prisma);
    projectId = base.projectId;
    const owner = { projectId, repoId: base.repoId, requestedById: base.adminId };
    runJob = await insertAnalyticsJob(prisma, owner, { costSpentUsd: '0.3', finishResult: 'promoted', escalationReason: 'x' });
    // Real config jobs carry no finishResult/escalationReason; set them here so the filter, not NULL-skipping, is what is tested.
    await insertAnalyticsJob(prisma, owner, { command: 'CONFIG_EDIT', feature: 'nax-config', finishResult: 'promoted', escalationReason: 'x' });
    await insertAnalyticsJob(prisma, owner, { command: 'CONFIG_DRIFT', feature: 'nax-config-2' });
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('counts finish results and escalation reasons of nax jobs only', async () => {
    expect(await repo.finishResults(projectId, from, to)).toEqual([{ value: 'promoted', count: 1 }]);
    expect(await repo.escalationReasons(projectId, from, to)).toEqual([{ value: 'x', count: 1 }]);
  });

  it('lists nax jobs only in topJobs', async () => {
    expect((await repo.topJobs(projectId, from, to, 10)).map((j) => j.jobId)).toEqual([runJob]);
  });
});

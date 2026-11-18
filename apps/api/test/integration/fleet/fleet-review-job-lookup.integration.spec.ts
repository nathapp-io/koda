import { PrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { canRunDbTests } from '../../helpers/test-environment';
import { PrismaFleetJobRepository } from '../../../src/fleet/jobs/prisma-fleet-job.repository';
import { PrismaFleetPrReviewRepository } from '../../../src/fleet/reviews/prisma-fleet-pr-review.repository';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { asTestActor, fixtureDb } from '../../helpers/action-context';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import type { NathApplication } from '@nathapp/nestjs-app';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('Fleet review job lookup and conditional claim link (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let jobs: PrismaFleetJobRepository;
  let reviews: PrismaFleetPrReviewRepository;
  let repoId: string;
  let projectId: string;
  let userId: string;
  let sequence = 0;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = asTestActor(fixtureDb(app), { type: 'SYSTEM', id: 'seed' });
    jobs = asTestActor(new PrismaFleetJobRepository(app.get(PrismaService)), { type: 'SYSTEM', id: 'seed' });
    reviews = asTestActor(new PrismaFleetPrReviewRepository(app.get(TRANSACTION_MANAGER), app.get(PrismaService)), { type: 'SYSTEM', id: 'seed' });
    const user = await prisma.user.create({ data: { email: 'review-lookup@koda.test', passwordHash: 'x' } });
    userId = user.id;
    const project = await prisma.project.create({ data: { name: 'Review lookup', slug: 'review-lookup', key: 'RVL' } });
    projectId = project.id;
    const repo = await prisma.fleetRepo.create({
      data: { projectId, provider: 'github', owner: 'acme', name: 'review-lookup', defaultBranch: 'main', githubInstallationId: 77n, createdById: userId },
    });
    repoId = repo.id;
  }, 30_000);

  afterAll(async () => { await app?.close(); });

  const createJob = async (values: { feature?: string; command?: string; createdAt: Date }) => {
    const id = `review-job-${++sequence}`;
    const row = await prisma.fleetJob.create({
      data: {
        id, projectId, repoId, ref: 'main', command: values.command ?? 'REVIEW', feature: values.feature ?? 'review-pr-12',
        profiles: [], maxCostUsd: '1', bashMode: 'raw', approvalTimeoutSec: 600, selectorLabels: [], pinnedRunnerId: null,
        requestedById: userId, state: 'COMPLETED',
      },
    });
    await prisma.fleetJob.update({ where: { id: row.id }, data: { createdAt: values.createdAt } });
    return row.id;
  };

  it('AC-1: returns the only matching REVIEW job when its creation time is within the inclusive window', async () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date('2026-01-01T00:00:10.000Z');
    const id = await createJob({ createdAt: from });
    const upperBoundaryId = await createJob({ feature: 'review-pr-14', createdAt: to });
    await expect(jobs.findReviewJobIdBetween(repoId, 12, from, to)).resolves.toBe(id);
    await expect(jobs.findReviewJobIdBetween(repoId, 14, from, to)).resolves.toBe(upperBoundaryId);
  });

  it('returns the oldest matching job when multiple REVIEW jobs fall within the window', async () => {
    const from = new Date('2026-01-05T00:00:00.000Z');
    const to = new Date('2026-01-05T00:00:10.000Z');
    const oldest = await createJob({ createdAt: new Date(from.getTime() + 2_000) });
    await createJob({ createdAt: new Date(from.getTime() + 5_000) });
    await expect(jobs.findReviewJobIdBetween(repoId, 12, from, to)).resolves.toBe(oldest);
  });

  it('excludes a non-REVIEW job even when its repo, feature and creation time match', async () => {
    const from = new Date('2026-01-06T00:00:00.000Z');
    const to = new Date('2026-01-06T00:00:10.000Z');
    await createJob({ feature: 'review-pr-16', command: 'RUN', createdAt: from });
    await expect(jobs.findReviewJobIdBetween(repoId, 16, from, to)).resolves.toBeNull();
  });

  it('AC-2: excludes a matching REVIEW job created before the window', async () => {
    const from = new Date('2026-01-02T00:00:00.000Z');
    const to = new Date('2026-01-02T00:00:10.000Z');
    await createJob({ createdAt: new Date(from.getTime() - 1) });
    await expect(jobs.findReviewJobIdBetween(repoId, 12, from, to)).resolves.toBeNull();
  });

  it('AC-3: excludes a matching REVIEW job created after the window', async () => {
    const from = new Date('2026-01-03T00:00:00.000Z');
    const to = new Date('2026-01-03T00:00:10.000Z');
    await createJob({ createdAt: new Date(to.getTime() + 1) });
    await expect(jobs.findReviewJobIdBetween(repoId, 12, from, to)).resolves.toBeNull();
  });

  it('AC-4: excludes a REVIEW job for a different PR feature', async () => {
    const from = new Date('2026-01-04T00:00:00.000Z');
    const to = new Date('2026-01-04T00:00:10.000Z');
    await createJob({ feature: 'review-pr-13', createdAt: from });
    await expect(jobs.findReviewJobIdBetween(repoId, 12, from, to)).resolves.toBeNull();
  });

  it('AC-5a: returns true when a pending claim without a job is conditionally dispatched', async () => {
    const claim = await reviews.insertPending(repoId, 101, 'head-101');
    if (claim === null) throw new Error('expected pending review claim');
    await expect(reviews.markDispatchedIfPending(claim.id, 'review-job-for-101')).resolves.toBe(true);
  });

  it('AC-5b: stores the dispatched outcome and job id for a pending claim', async () => {
    const claim = await reviews.insertPending(repoId, 102, 'head-102');
    if (claim === null) throw new Error('expected pending review claim');
    expect(await reviews.markDispatchedIfPending(claim.id, 'review-job-for-102')).toBe(true);
    expect(await reviews.findHead(repoId, 102, 'head-102')).toMatchObject({ outcome: 'dispatched', jobId: 'review-job-for-102' });
  });

  it('AC-7: leaves an already-dispatched claim unchanged and returns false', async () => {
    const claim = await reviews.insertPending(repoId, 103, 'head-103');
    if (claim === null) throw new Error('expected pending review claim');
    await reviews.markDispatched(claim.id, 'original-job');
    expect(await reviews.markDispatchedIfPending(claim.id, 'replacement-job')).toBe(false);
    expect(await reviews.findHead(repoId, 103, 'head-103')).toMatchObject({ outcome: 'dispatched', jobId: 'original-job' });
  });

  it('AC-8: returns false when the claim id does not exist', async () => {
    await expect(reviews.markDispatchedIfPending('missing-review-claim', 'job')).resolves.toBe(false);
  });
});

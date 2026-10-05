/**
 * Fleet S2b slice 1b — analytics read repository (PG), spec §4.1-4.2.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-analytics-repository.integration.spec.ts
 */
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { resetDb } from '../../helpers/reset-db';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import {
  insertAnalyticsJob, insertCostEvent, insertIngestRow, insertReviewResult, insertStoryResult,
} from '../../helpers/fleet-analytics-fixtures';
import { bucketStart } from '../../../src/fleet/analytics/analytics-window';
import { NONE_KEY } from '../../../src/fleet/analytics/domain/analytics.domain';
import { PrismaAnalyticsRepository } from '../../../src/fleet/analytics/prisma-analytics.repository';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('analytics read repository (PG)', () => {
  const prisma = new PrismaClient();
  const repo = new PrismaAnalyticsRepository({ client: prisma } as unknown as PrismaService<PrismaClient>);
  const w = { from: new Date('2026-09-28T00:00:00Z'), to: new Date('2026-10-12T00:00:00Z'), bucket: 'week' as const };
  const tok = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 5 };
  let a: Awaited<ReturnType<typeof seedFleetBase>>;
  let b: Awaited<ReturnType<typeof seedFleetBase>>;
  let job1: string;
  let job2: string;

  beforeAll(async () => {
    await resetDb();
    a = await seedFleetBase(prisma);
    b = await seedFleetBase(prisma);
    const ownerA = { projectId: a.projectId, repoId: a.repoId, requestedById: a.adminId };
    job1 = await insertAnalyticsJob(prisma, ownerA, {
      leaseEpoch: 2, costSpentUsd: '0.5', costCarriedUsd: '0.1', finishResult: 'escalated',
      escalationReason: 'quality review omitted\nWALK', state: 'ESCALATED',
    });
    job2 = await insertAnalyticsJob(prisma, ownerA, { command: 'PLAN', costSpentUsd: '0.2', finishResult: 'promoted', finishedAt: new Date('2026-10-03T00:00:00Z') });
    await insertAnalyticsJob(prisma, ownerA, { costSpentUsd: '9', finishedAt: new Date('2026-08-01T00:00:00Z') }); // outside the window
    await insertAnalyticsJob(prisma, ownerA, { finishResult: null, finishedAt: new Date('2026-10-04T00:00:00Z') });
    const row1 = { jobId: job1, projectId: a.projectId, repoId: a.repoId };
    await insertCostEvent(prisma, row1, { ...tok, at: new Date('2026-10-04T23:59:59Z'), model: 'm1', costUsd: '0.00004' }); // Sunday
    await insertCostEvent(prisma, row1, { ...tok, at: new Date('2026-10-04T23:00:00Z'), model: 'm1', costUsd: '0.00004' });
    await insertCostEvent(prisma, row1, { ...tok, at: new Date('2026-10-05T00:00:00Z'), model: 'm2', sessionRole: null, storyId: null, costUsd: '0.00004' }); // Monday
    await insertCostEvent(prisma, row1, { ...tok, at: new Date('2026-10-12T00:00:00Z'), model: 'm1', costUsd: '9' }); // at `to`: excluded
    const jobB = await insertAnalyticsJob(prisma, { projectId: b.projectId, repoId: b.repoId, requestedById: b.adminId });
    await insertCostEvent(prisma, { jobId: jobB, projectId: b.projectId, repoId: b.repoId }, { at: new Date('2026-10-03T00:00:00Z'), costUsd: '5' });
    await insertStoryResult(prisma, row1, { storyId: 'US-001', attempts: 1, firstPassSuccess: true, costUsd: '0.2', completedAt: new Date('2026-10-02T00:00:00Z') });
    await insertStoryResult(prisma, row1, { storyId: 'US-002', attempts: 3, firstPassSuccess: false, costUsd: '0.3', completedAt: new Date('2026-10-06T00:00:00Z') });
    await insertStoryResult(prisma, row1, { storyId: 'US-003', completedAt: null });
    await insertStoryResult(prisma, row1, { storyId: 'US-004', completedAt: new Date('2026-09-01T00:00:00Z') });
    await insertReviewResult(prisma, row1, { reviewer: 'semantic', passed: true, findingsBySeverity: { error: 1, warning: 2 } });
    await insertReviewResult(prisma, row1, { reviewer: 'semantic', passed: false, findingsBySeverity: { error: 1 } });
    await insertReviewResult(prisma, row1, { reviewer: 'adversarial', passed: true });
    await insertIngestRow(prisma, job1, 1, { status: 'done', ledgerCostUsd: '0.25' });
    await insertIngestRow(prisma, job1, 2, { status: 'partial', ledgerCostUsd: '0.4', liveCostUsd: '0.35', files: { cost: 'done:v8', review: 'skipped:v3' } });
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('groups spend by key and bucket, aligned with bucketStart across a week boundary', async () => {
    const cells = (await repo.spendCells({ projectId: a.projectId }, w, 'model')).sort((x, y) => (x.key < y.key ? -1 : 1));
    expect(cells.map((c) => ({ key: c.key, t: c.t.toISOString(), cost: c.costUsd.toFixed(8), tokens: c.tokens }))).toEqual([
      { key: 'm1', t: '2026-09-28T00:00:00.000Z', cost: '0.00008000', tokens: 330 },
      { key: 'm2', t: '2026-10-05T00:00:00.000Z', cost: '0.00004000', tokens: 165 },
    ]);
    expect(cells[0].t).toEqual(bucketStart(new Date('2026-10-04T23:59:59Z'), 'week'));
    expect(cells[1].t).toEqual(bucketStart(new Date('2026-10-05T00:00:00Z'), 'week'));
  });

  it('keys a null dimension as (none) and scopes to every project when projectId is null', async () => {
    const roles = await repo.spendCells({ projectId: a.projectId }, w, 'role');
    expect(roles.map((c) => c.key).sort()).toEqual([NONE_KEY, 'implementer']);
    const projects = await repo.spendCells({ projectId: null }, w, 'project');
    expect(new Set(projects.map((c) => c.key))).toEqual(new Set([a.projectId, b.projectId]));
  });

  it('totals unrounded money, tokens and distinct jobs; zero on an empty window', async () => {
    const t = await repo.spendTotals({ projectId: a.projectId }, w.from, w.to);
    expect({ ...t, costUsd: t.costUsd.toFixed(8) }).toEqual({
      costUsd: '0.00012000', inputTokens: 300, outputTokens: 30, cacheReadTokens: 150, cacheWriteTokens: 15, jobs: 1,
    });
    const empty = await repo.spendTotals({ projectId: a.projectId }, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-02T00:00:00Z'));
    expect({ ...empty, costUsd: empty.costUsd.toFixed(4) }).toEqual({
      costUsd: '0.0000', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, jobs: 0,
    });
  });

  it('labels repos and projects; other dimensions have no labels', async () => {
    expect((await repo.labels('repo', [a.repoId, NONE_KEY])).get(a.repoId)).toMatch(/^acme\/app\d+$/);
    expect((await repo.labels('project', [a.projectId])).get(a.projectId)).toBe(a.projectSlug);
    expect((await repo.labels('model', ['m1'])).size).toBe(0);
  });

  it('computes story stats and first-pass cells by completedAt', async () => {
    expect(await repo.storyStats(a.projectId, w.from, w.to)).toEqual({ stories: 2, firstPass: 1, attempts: 4 });
    const cells = await repo.firstPassCells(a.projectId, w);
    expect(cells.map((c) => ({ ...c, t: c.t.toISOString() }))).toEqual([
      { t: '2026-09-28T00:00:00.000Z', stories: 1, firstPass: 1 },
      { t: '2026-10-05T00:00:00.000Z', stories: 1, firstPass: 0 },
    ]);
  });

  it('aggregates reviews per reviewer and their findings by severity', async () => {
    expect(await repo.reviewers(a.projectId, w.from, w.to)).toEqual([
      { reviewer: 'adversarial', runs: 1, passed: 1 },
      { reviewer: 'semantic', runs: 2, passed: 1 },
    ]);
    expect(await repo.reviewerSeverities(a.projectId, w.from, w.to)).toEqual([
      { reviewer: 'semantic', severity: 'error', count: 2 },
      { reviewer: 'semantic', severity: 'warning', count: 2 },
    ]);
  });

  it('counts finish results and raw escalation reasons by finishedAt', async () => {
    expect(await repo.finishResults(a.projectId, w.from, w.to)).toEqual([
      { value: 'escalated', count: 1 },
      { value: 'promoted', count: 1 },
    ]);
    expect(await repo.escalationReasons(a.projectId, w.from, w.to)).toEqual([{ value: 'quality review omitted\nWALK', count: 1 }]);
  });

  it('lists the most expensive and the most looping stories', async () => {
    const byCost = await repo.topStories(a.projectId, w.from, w.to, 'cost', 10);
    expect(byCost.map((s) => [s.storyId, s.costUsd.toFixed(4)])).toEqual([['US-002', '0.3000'], ['US-001', '0.2000']]);
    expect((await repo.topStories(a.projectId, w.from, w.to, 'attempts', 1)).map((s) => s.storyId)).toEqual(['US-002']);
  });

  it('lists jobs by total cost with their summed ledger', async () => {
    const jobs = await repo.topJobs(a.projectId, w.from, w.to, 10);
    expect(jobs.map((j) => [j.jobId, j.costUsd.toFixed(4), j.ledgerCostUsd === null ? null : j.ledgerCostUsd.toFixed(4)])).toEqual([
      [job1, '0.6000', '0.6500'],
      [job2, '0.2000', null],
      [expect.any(String), '0.0000', null],
    ]);
  });

  it('breaks one job down across all attempts and reads its latest ingest row', async () => {
    const models = await repo.jobSlices(job1, 'model');
    expect(models.map((s) => [s.key, s.costUsd.toFixed(5), s.tokens])).toEqual([['m1', '9.00008', 495], ['m2', '0.00004', 165]]);
    expect((await repo.jobSlices(job1, 'role')).map((s) => s.key)).toEqual(['implementer', NONE_KEY]);
    const ingest = await repo.latestIngest(job1);
    expect(ingest).toMatchObject({ leaseEpoch: 2, status: 'partial', files: { cost: 'done:v8', review: 'skipped:v3' }, error: null });
    expect(ingest.ledgerCostUsd.toFixed(4)).toBe('0.4000');
    expect(ingest.liveCostUsd.toFixed(4)).toBe('0.3500');
    expect(await repo.latestIngest(job2)).toBeNull();
    expect((await repo.jobStories(job1, 500)).map((s) => s.storyId)).toEqual(['US-001', 'US-002', 'US-003', 'US-004']);
    expect((await repo.jobStories(job1, 2))).toHaveLength(2);
    expect((await repo.jobReviews(job1, 500)).map((r) => r.reviewer).sort()).toEqual(['adversarial', 'semantic', 'semantic']);
  });
});

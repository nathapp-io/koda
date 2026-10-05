import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { Prisma } from '@prisma/client';
import { ESCALATED_FROM_AUDIT } from '../ingest/ingest-corrections';
import { AnalyticsService } from './analytics.service';
import type { IAnalyticsRepository } from './domain/analytics.domain';

const D = (v: string) => new Prisma.Decimal(v);
const now = new Date('2026-10-05T12:00:00.000Z');
const EMPTY_TOTALS = { costUsd: D('0'), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, jobs: 0 };

function fakeRepo(over: Partial<Record<keyof IAnalyticsRepository, jest.Mock>> = {}): IAnalyticsRepository & Record<string, jest.Mock> {
  return {
    spendCells: jest.fn().mockResolvedValue([]),
    spendTotals: jest.fn().mockResolvedValue(EMPTY_TOTALS),
    jobCostSums: jest.fn().mockResolvedValue([]),
    ingestHealth: jest.fn().mockResolvedValue({ pending: 0, failed: 0 }),
    labels: jest.fn().mockResolvedValue(new Map()),
    storyStats: jest.fn().mockResolvedValue({ stories: 0, firstPass: 0, attempts: 0 }),
    firstPassCells: jest.fn().mockResolvedValue([]),
    reviewers: jest.fn().mockResolvedValue([]),
    reviewerSeverities: jest.fn().mockResolvedValue([]),
    finishResults: jest.fn().mockResolvedValue([]),
    escalationReasons: jest.fn().mockResolvedValue([]),
    topStories: jest.fn().mockResolvedValue([]),
    topJobs: jest.fn().mockResolvedValue([]),
    jobSlices: jest.fn().mockResolvedValue([]),
    latestIngest: jest.fn().mockResolvedValue(null),
    jobStories: jest.fn().mockResolvedValue([]),
    jobReviews: jest.fn().mockResolvedValue([]),
    findProjectSlug: jest.fn().mockResolvedValue('web'),
    deleteRows: jest.fn().mockResolvedValue({ costEvents: 3, stories: 2, reviews: 1, ingestRowsMarked: 1 }),
    ...over,
  } as IAnalyticsRepository & Record<string, jest.Mock>;
}

describe('AnalyticsService', () => {
  const jobs = { findById: jest.fn() };
  const activity = { record: jest.fn() };
  const txManager = { run: jest.fn((fn: () => Promise<unknown>) => fn()) };
  const make = (repo: IAnalyticsRepository) => new AnalyticsService(repo, jobs as never, activity as never, txManager as never);

  afterEach(() => jest.clearAllMocks());

  it('answers an empty project with zero money, null rates and no series', async () => {
    const s = await make(fakeRepo()).spend('p1', {}, now);
    expect(s).toEqual({
      window: { from: '2026-09-05T12:00:00.000Z', to: '2026-10-05T12:00:00.000Z' }, bucket: 'day', groupBy: 'model',
      totals: { costUsd: '0.0000', tokens: 0, cacheShare: null, jobs: 0, medianJobCostUsd: null }, series: [],
    });
  });

  it('passes the scope and group, labels the series and computes the cache share', async () => {
    const repo = fakeRepo({
      spendCells: jest.fn().mockResolvedValue([{ key: 'r1', t: new Date('2026-10-01T00:00:00Z'), costUsd: D('1.23456'), tokens: 9 }]),
      spendTotals: jest.fn().mockResolvedValue({ costUsd: D('1.23456'), inputTokens: 300, outputTokens: 30, cacheReadTokens: 150, cacheWriteTokens: 15, jobs: 2 }),
      labels: jest.fn().mockResolvedValue(new Map([['r1', 'acme/app']])),
    });
    const s = await make(repo).spend(null, { from: '2026-10-01', to: '2026-10-03', groupBy: 'repo' }, now);
    expect(repo.spendCells).toHaveBeenCalledWith({ projectId: null }, expect.objectContaining({ bucket: 'day' }), 'repo');
    expect(repo.labels).toHaveBeenCalledWith('repo', ['r1']);
    expect(s.totals).toEqual({ costUsd: '1.2346', tokens: 495, cacheShare: 0.3333, jobs: 2, medianJobCostUsd: null });
    expect(s.series).toEqual([expect.objectContaining({ key: 'r1', label: 'acme/app', costUsd: '1.2346', points: expect.any(Array) })]);
    expect(s.series[0].points).toHaveLength(2);
  });

  it('reports the median per-job spend rounded once, and folds after `top` series (D388)', async () => {
    const t = new Date('2026-10-01T00:00:00Z');
    const repo = fakeRepo({
      spendCells: jest.fn().mockResolvedValue([
        { key: 'a', t, costUsd: D('3'), tokens: 1 },
        { key: 'b', t, costUsd: D('2'), tokens: 1 },
        { key: 'c', t, costUsd: D('1'), tokens: 1 },
      ]),
      jobCostSums: jest.fn().mockResolvedValue([D('0.00001'), D('0.00002')]),
    });
    const s = await make(repo).spend('p1', { from: '2026-10-01', to: '2026-10-02', top: 2 }, now);
    expect(repo.jobCostSums).toHaveBeenCalledWith({ projectId: 'p1' }, new Date('2026-10-01T00:00:00Z'), new Date('2026-10-02T00:00:00Z'));
    expect(s.totals.medianJobCostUsd).toBe('0.0000');
    expect(s.series.map((x) => [x.key, x.folded, x.costUsd])).toEqual([['a', false, '3.0000'], ['b', false, '2.0000'], ['other', true, '1.0000']]);
  });

  it('keeps 12 series when top is absent', async () => {
    const t = new Date('2026-10-01T00:00:00Z');
    const cells = Array.from({ length: 13 }, (_, i) => ({ key: `k${String(i).padStart(2, '0')}`, t, costUsd: D(String(13 - i)), tokens: 1 }));
    const s = await make(fakeRepo({ spendCells: jest.fn().mockResolvedValue(cells) })).spend('p1', { from: '2026-10-01', to: '2026-10-02' }, now);
    expect(s.series).toHaveLength(13);
    expect(s.series[12]).toMatchObject({ key: 'other', folded: true });
  });

  it('rejects an invalid window before touching the repository', async () => {
    const repo = fakeRepo();
    await expect(make(repo).spend('p1', { from: '2026-10-03', to: '2026-10-01' }, now)).rejects.toBeInstanceOf(ValidationAppException);
    expect(repo.spendCells).not.toHaveBeenCalled();
  });

  it('answers quality with null rates and a zero-filled series when there is no data', async () => {
    const q = await make(fakeRepo()).quality('p1', {}, now);
    expect(q).toMatchObject({
      stories: 0, firstPassRate: null, avgAttempts: null, reviewByReviewer: [], topEscalationReasons: [],
      finishOutcomes: { opened: 0, promoted: 0, escalated: 0, skipped: 0, other: 0 },
    });
    expect(q.firstPassSeries).toHaveLength(31);
    expect(q.firstPassSeries.every((p) => p.rate === null)).toBe(true);
  });

  it('computes first-pass rate and average attempts', async () => {
    const q = await make(fakeRepo({ storyStats: jest.fn().mockResolvedValue({ stories: 4, firstPass: 3, attempts: 6 }) })).quality('p1', {}, now);
    expect(q.firstPassRate).toBe(0.75);
    expect(q.avgAttempts).toBe(1.5);
  });

  it('lists stories with the default limit and sort, and jobs with drift', async () => {
    const repo = fakeRepo({
      topStories: jest.fn().mockResolvedValue([{
        jobId: 'j1', leaseEpoch: 1, featureName: 'f', storyId: 'US-1', attempts: 2, firstPassSuccess: false, success: true,
        costUsd: D('0.30004'), completedAt: new Date('2026-10-02T00:00:00Z'),
      }]),
      topJobs: jest.fn().mockResolvedValue([
        { jobId: 'j1', command: 'RUN', featureName: 'f', state: 'COMPLETED', costUsd: D('0.6'), ledgerCostUsd: D('0.65'), finishedAt: new Date('2026-10-02T00:00:00Z') },
        { jobId: 'j2', command: 'PLAN', featureName: 'g', state: 'COMPLETED', costUsd: D('0.2'), ledgerCostUsd: null, finishedAt: null },
      ]),
    });
    const svc = make(repo);
    const stories = await svc.stories('p1', {}, now);
    expect(repo.topStories).toHaveBeenCalledWith('p1', expect.any(Date), now, 'cost', 20);
    expect(stories.rows[0]).toMatchObject({ storyId: 'US-1', costUsd: '0.3000', completedAt: '2026-10-02T00:00:00.000Z' });
    const jobsView = await svc.jobs('p1', { limit: 5 }, now);
    expect(repo.topJobs).toHaveBeenCalledWith('p1', expect.any(Date), now, 5);
    expect(jobsView.rows.map((r) => [r.costUsd, r.ledgerCostUsd, r.driftUsd, r.finishedAt])).toEqual([
      ['0.6000', '0.6500', '0.0500', '2026-10-02T00:00:00.000Z'],
      ['0.2000', null, null, null],
    ]);
  });

  it('breaks a job down, 404 outside the project', async () => {
    jobs.findById.mockResolvedValue({ id: 'j1', projectId: 'p1', stateReason: ESCALATED_FROM_AUDIT });
    const repo = fakeRepo({
      jobSlices: jest.fn().mockResolvedValue([{ key: 'm1', costUsd: D('0.00012'), tokens: 10 }]),
      latestIngest: jest.fn().mockResolvedValue({
        leaseEpoch: 2, status: 'done', files: { cost: 'done:v8' }, ingestedAt: new Date('2026-10-02T13:00:00Z'), error: null,
        liveCostUsd: D('0.4'), ledgerCostUsd: D('0.5'),
      }),
    });
    const view = await make(repo).job('p1', 'j1');
    expect(repo.jobSlices).toHaveBeenCalledWith('j1', 'stage');
    expect(repo.jobStories).toHaveBeenCalledWith('j1', 500);
    expect(view).toMatchObject({
      jobId: 'j1', corrected: true, liveCostUsd: '0.4000', ledgerCostUsd: '0.5000',
      ingest: { leaseEpoch: 2, status: 'done', files: { cost: 'done:v8' }, ingestedAt: '2026-10-02T13:00:00.000Z', error: null },
      byModel: [{ key: 'm1', costUsd: '0.0001', tokens: 10 }],
    });
    jobs.findById.mockResolvedValue({ id: 'j9', projectId: 'other', stateReason: null });
    await expect(make(fakeRepo()).job('p1', 'j9')).rejects.toBeInstanceOf(NotFoundAppException);
    jobs.findById.mockResolvedValue(null);
    await expect(make(fakeRepo()).job('p1', 'nope')).rejects.toBeInstanceOf(NotFoundAppException);
  });

  it('answers a job with no ingest yet with null ingest and costs', async () => {
    jobs.findById.mockResolvedValue({ id: 'j1', projectId: 'p1', stateReason: null });
    expect(await make(fakeRepo()).job('p1', 'j1')).toMatchObject({ ingest: null, liveCostUsd: null, ledgerCostUsd: null, corrected: false });
  });

  it('deletes only with the right confirmation and records the activity', async () => {
    const repo = fakeRepo();
    const svc = make(repo);
    await expect(svc.deleteRows('u1', { before: '2026-10-01T00:00:00Z', confirm: 'web' }, now)).rejects.toBeInstanceOf(ValidationAppException);
    await expect(svc.deleteRows('u1', { before: '2026-10-01T00:00:00Z', projectId: 'p1', confirm: 'ALL' }, now)).rejects.toBeInstanceOf(ValidationAppException);
    (repo.findProjectSlug as jest.Mock).mockResolvedValueOnce(null);
    await expect(svc.deleteRows('u1', { before: '2026-10-01T00:00:00Z', projectId: 'gone', confirm: 'gone' }, now)).rejects.toBeInstanceOf(NotFoundAppException);
    expect(repo.deleteRows).not.toHaveBeenCalled();

    const view = await svc.deleteRows('u1', { before: '2026-10-01T00:00:00Z', projectId: 'p1', confirm: 'web' }, now);
    expect(repo.deleteRows).toHaveBeenCalledWith({ projectId: 'p1', before: new Date('2026-10-01T00:00:00Z'), now });
    expect(view).toEqual({ projectId: 'p1', before: '2026-10-01T00:00:00.000Z', costEvents: 3, stories: 2, reviews: 1, ingestRowsMarked: 1 });
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({
      actorType: 'USER', actorId: 'u1', action: 'analytics.deleted', entityType: 'analytics', entityId: 'p1', projectId: 'p1',
      payload: { before: '2026-10-01T00:00:00.000Z', costEvents: 3, stories: 2, reviews: 1, ingestRowsMarked: 1 },
    }));
    expect(txManager.run).toHaveBeenCalledTimes(1);

    await svc.deleteRows('u1', { before: '2026-10-01T00:00:00Z', confirm: 'ALL' }, now);
    expect(activity.record).toHaveBeenLastCalledWith(expect.objectContaining({ entityId: 'all', projectId: null }));
  });

  it('counts unfinished and failed ingests of jobs finished in the window (D388)', async () => {
    const repo = fakeRepo({ ingestHealth: jest.fn().mockResolvedValue({ pending: 2, failed: 1 }) });
    const r = await make(repo).ingestHealth('p1', { from: '2026-10-01', to: '2026-10-08' }, now);
    expect(repo.ingestHealth).toHaveBeenCalledWith('p1', new Date('2026-10-01T00:00:00Z'), new Date('2026-10-08T00:00:00Z'));
    expect(r).toEqual({ window: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' }, pending: 2, failed: 1 });
  });
});

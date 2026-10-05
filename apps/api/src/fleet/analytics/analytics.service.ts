import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { ESCALATED_FROM_AUDIT } from '../ingest/ingest-corrections';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { foldSeries } from './analytics-fold';
import { finishOutcomes, firstPassSeries, reviewerViews, topReasons } from './analytics-quality';
import { bucketStarts, invalidAnalytics, medianMoney, rate4, resolveWindow, usd4, usd4OrNull } from './analytics-window';
import type {
  CostSliceView, DeleteInput, DeletedView, IngestHealthView, JobAnalyticsView, JobsView, ListInput, QualityView, SpendInput, SpendView,
  StoriesInput, StoriesView, WindowInput, WindowView,
} from './analytics.types';
import { ANALYTICS_LIMITS, ANALYTICS_REPOSITORY, AnalyticsWindow, CostSliceRow, IAnalyticsRepository } from './domain/analytics.domain';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const windowView = (w: AnalyticsWindow): WindowView => ({ from: w.from.toISOString(), to: w.to.toISOString() });
const slice = (s: CostSliceRow): CostSliceView => ({ key: s.key, costUsd: usd4(s.costUsd), tokens: s.tokens });

/** Fleet S2b (d) §4: cost and quality analytics over the slice 1a tables. Money is rounded only here (A7). */
@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(ANALYTICS_REPOSITORY) private readonly repo: IAnalyticsRepository,
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobRepo: Pick<IFleetJobRepository, 'findById'>,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  /** Spec §4.2 spend; `projectId: null` is the admin route across projects. */
  async spend(projectId: string | null, q: SpendInput, now: Date): Promise<SpendView> {
    const w = resolveWindow(q, now);
    const groupBy = q.groupBy ?? 'model';
    const scope = { projectId };
    const [cells, totals, jobSums] = await Promise.all([
      this.repo.spendCells(scope, w, groupBy),
      this.repo.spendTotals(scope, w.from, w.to),
      this.repo.jobCostSums(scope, w.from, w.to),
    ]);
    const labels = await this.repo.labels(groupBy, [...new Set(cells.map((c) => c.key))]);
    return {
      window: windowView(w),
      bucket: w.bucket,
      groupBy,
      totals: {
        costUsd: usd4(totals.costUsd),
        tokens: totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens,
        cacheShare: rate4(totals.cacheReadTokens, totals.inputTokens + totals.cacheReadTokens),
        jobs: totals.jobs,
        medianJobCostUsd: usd4OrNull(medianMoney(jobSums)),
      },
      series: foldSeries(cells, bucketStarts(w), labels, q.top ?? ANALYTICS_LIMITS.seriesKeep),
    };
  }

  async quality(projectId: string, q: WindowInput, now: Date): Promise<QualityView> {
    const w = resolveWindow(q, now);
    const [stats, cells, reviewers, severities, finishes, reasons] = await Promise.all([
      this.repo.storyStats(projectId, w.from, w.to),
      this.repo.firstPassCells(projectId, w),
      this.repo.reviewers(projectId, w.from, w.to),
      this.repo.reviewerSeverities(projectId, w.from, w.to),
      this.repo.finishResults(projectId, w.from, w.to),
      this.repo.escalationReasons(projectId, w.from, w.to),
    ]);
    return {
      window: windowView(w),
      bucket: w.bucket,
      stories: stats.stories,
      firstPassRate: rate4(stats.firstPass, stats.stories),
      avgAttempts: rate4(stats.attempts, stats.stories),
      reviewByReviewer: reviewerViews(reviewers, severities),
      finishOutcomes: finishOutcomes(finishes),
      topEscalationReasons: topReasons(reasons),
      firstPassSeries: firstPassSeries(cells, bucketStarts(w)),
    };
  }

  async stories(projectId: string, q: StoriesInput, now: Date): Promise<StoriesView> {
    const w = resolveWindow({ from: q.from, to: q.to }, now);
    const rows = await this.repo.topStories(projectId, w.from, w.to, q.sort ?? 'cost', q.limit ?? ANALYTICS_LIMITS.listDefault);
    return { window: windowView(w), rows: rows.map((r) => ({ ...r, costUsd: usd4(r.costUsd), completedAt: iso(r.completedAt) })) };
  }

  /** D382: cost = spent + carried; drift = ledger - cost. */
  async jobs(projectId: string, q: ListInput, now: Date): Promise<JobsView> {
    const w = resolveWindow({ from: q.from, to: q.to }, now);
    const rows = await this.repo.topJobs(projectId, w.from, w.to, q.limit ?? ANALYTICS_LIMITS.listDefault);
    return {
      window: windowView(w),
      rows: rows.map((r) => ({
        jobId: r.jobId, command: r.command, featureName: r.featureName, state: r.state,
        costUsd: usd4(r.costUsd), ledgerCostUsd: usd4OrNull(r.ledgerCostUsd),
        driftUsd: r.ledgerCostUsd === null ? null : usd4(r.ledgerCostUsd.sub(r.costUsd)),
        finishedAt: iso(r.finishedAt),
      })),
    };
  }

  /** D388: the project page's "not yet analysed" notice. */
  async ingestHealth(projectId: string, q: WindowInput, now: Date): Promise<IngestHealthView> {
    const w = resolveWindow({ from: q.from, to: q.to }, now);
    const counts = await this.repo.ingestHealth(projectId, w.from, w.to);
    return { window: windowView(w), ...counts };
  }

  /** Spec §4.2 job breakdown, D383. */
  async job(projectId: string, jobId: string): Promise<JobAnalyticsView> {
    const job = await this.jobRepo.findById(jobId);
    if (!job || job.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.jobs');
    const max = ANALYTICS_LIMITS.jobDetailRows;
    const [ingest, byStage, byRole, byModel, stories, reviews] = await Promise.all([
      this.repo.latestIngest(job.id),
      this.repo.jobSlices(job.id, 'stage'),
      this.repo.jobSlices(job.id, 'role'),
      this.repo.jobSlices(job.id, 'model'),
      this.repo.jobStories(job.id, max),
      this.repo.jobReviews(job.id, max),
    ]);
    return {
      jobId: job.id,
      ingest: ingest
        ? { leaseEpoch: ingest.leaseEpoch, status: ingest.status, files: ingest.files, ingestedAt: iso(ingest.ingestedAt), error: ingest.error }
        : null,
      byStage: byStage.map(slice),
      byRole: byRole.map(slice),
      byModel: byModel.map(slice),
      stories: stories.map((s) => ({ ...s, costUsd: usd4(s.costUsd), completedAt: iso(s.completedAt) })),
      reviews: reviews.map((r) => ({ ...r, at: r.at.toISOString() })),
      liveCostUsd: ingest ? usd4OrNull(ingest.liveCostUsd) : null,
      ledgerCostUsd: ingest ? usd4OrNull(ingest.ledgerCostUsd) : null,
      corrected: job.stateReason === ESCALATED_FROM_AUDIT,
    };
  }

  /** Spec §4.3, D384: delete-on-demand (global admin). */
  async deleteRows(actorId: string, q: DeleteInput, now: Date): Promise<DeletedView> {
    const before = new Date(q.before);
    if (Number.isNaN(before.getTime())) throw invalidAnalytics('before must be an ISO 8601 instant');
    const projectId = q.projectId ?? null;
    const expected = projectId === null ? 'ALL' : await this.repo.findProjectSlug(projectId);
    if (expected === null) throw new NotFoundAppException({}, 'projects');
    if (q.confirm !== expected) throw new ValidationAppException({ expected }, 'fleet.analyticsDelete');
    const counts = await this.txManager.run(async () => {
      const deleted = await this.repo.deleteRows({ projectId, before, now });
      await this.activity.record({
        actorType: 'USER', actorId, action: 'analytics.deleted', entityType: 'analytics', entityId: projectId ?? 'all', projectId,
        responsibleUserId: actorId, payload: { before: before.toISOString(), ...deleted },
      });
      return deleted;
    });
    return { projectId, before: before.toISOString(), ...counts };
  }
}

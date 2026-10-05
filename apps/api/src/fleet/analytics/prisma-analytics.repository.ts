import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import {
  AnalyticsScope, AnalyticsWindow, Bucket, CostSliceRow, CountRow, DeleteAnalyticsInput, DeletedCounts, FirstPassCell, GroupBy,
  IAnalyticsRepository, IngestHealthRow, JobIngestRow, JobListRow, JobReviewRow, JobSliceBy, JobStoryRow, NONE_KEY, ReviewerRow, ReviewerSeverityRow,
  SpendCell, SpendTotalsRow, StoryListRow, StorySort, StoryStatsRow,
} from './domain/analytics.domain';

/** Fixed SQL fragments keyed by validated enums: request text never reaches the SQL. */
const GROUP_KEY: Record<GroupBy, Prisma.Sql> = {
  model: Prisma.sql`e."model"`,
  stage: Prisma.sql`e."stage"`,
  role: Prisma.sql`COALESCE(e."sessionRole", ${NONE_KEY})`,
  repo: Prisma.sql`e."repoId"`,
  runner: Prisma.sql`COALESCE(e."runnerId", ${NONE_KEY})`,
  feature: Prisma.sql`e."featureName"`,
  story: Prisma.sql`COALESCE(e."storyId", ${NONE_KEY})`,
  project: Prisma.sql`e."projectId"`,
};
const SLICE_KEY: Record<JobSliceBy, Prisma.Sql> = { stage: GROUP_KEY.stage, role: GROUP_KEY.role, model: GROUP_KEY.model };
const TRUNC: Record<Bucket, Prisma.Sql> = { day: Prisma.raw(`'day'`), week: Prisma.raw(`'week'`), month: Prisma.raw(`'month'`) };
/** D379: one token measure. */
const TOKENS = Prisma.sql`(e."inputTokens"::bigint + e."outputTokens" + e."cacheReadTokens" + e."cacheWriteTokens")`;
/** Severity counts are ints written by ingest; anything else counts 0 instead of failing the query. */
const SEVERITIES = Prisma.sql`jsonb_each_text(CASE WHEN jsonb_typeof(r."findingsBySeverity") = 'object' THEN r."findingsBySeverity" ELSE '{}'::jsonb END)`;

const num = (v: unknown): number => Number(v ?? 0);
const dec = (v: unknown): Prisma.Decimal => new Prisma.Decimal((v ?? 0) as Prisma.Decimal | string | number);
const decOrNull = (v: unknown): Prisma.Decimal | null => (v === null || v === undefined ? null : dec(v));
const inScope = (scope: AnalyticsScope): Prisma.Sql =>
  (scope.projectId === null ? Prisma.empty : Prisma.sql`AND e."projectId" = ${scope.projectId}`);

type Raw = Record<string, unknown>;

@Injectable()
export class PrismaAnalyticsRepository implements IAnalyticsRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  /** Transaction-scoped inside txManager.run (nestjs-prisma ALS proxy). */
  private get db() {
    return this.prisma.client;
  }

  async spendCells(scope: AnalyticsScope, w: AnalyticsWindow, groupBy: GroupBy): Promise<SpendCell[]> {
    const rows = await this.db.$queryRaw<Raw[]>(Prisma.sql`
      SELECT ${GROUP_KEY[groupBy]} AS "key", date_trunc(${TRUNC[w.bucket]}, e."at") AS "t",
        SUM(e."costUsd") AS "cost", SUM(${TOKENS}) AS "tokens"
      FROM "FleetCostEvent" e
      WHERE e."at" >= ${w.from} AND e."at" < ${w.to} ${inScope(scope)}
      GROUP BY 1, 2`);
    return rows.map((r) => ({ key: r.key as string, t: r.t as Date, costUsd: dec(r.cost), tokens: num(r.tokens) }));
  }

  async spendTotals(scope: AnalyticsScope, from: Date, to: Date): Promise<SpendTotalsRow> {
    const [r] = await this.db.$queryRaw<Raw[]>(Prisma.sql`
      SELECT SUM(e."costUsd") AS "cost", SUM(e."inputTokens") AS "input", SUM(e."outputTokens") AS "output",
        SUM(e."cacheReadTokens") AS "cacheRead", SUM(e."cacheWriteTokens") AS "cacheWrite", COUNT(DISTINCT e."jobId") AS "jobs"
      FROM "FleetCostEvent" e
      WHERE e."at" >= ${from} AND e."at" < ${to} ${inScope(scope)}`);
    return {
      costUsd: dec(r.cost), inputTokens: num(r.input), outputTokens: num(r.output),
      cacheReadTokens: num(r.cacheRead), cacheWriteTokens: num(r.cacheWrite), jobs: num(r.jobs),
    };
  }

  async jobCostSums(scope: AnalyticsScope, from: Date, to: Date): Promise<Prisma.Decimal[]> {
    const rows = await this.db.$queryRaw<Raw[]>(Prisma.sql`
      SELECT SUM(e."costUsd") AS "cost"
      FROM "FleetCostEvent" e
      WHERE e."at" >= ${from} AND e."at" < ${to} ${inScope(scope)}
      GROUP BY e."jobId"`);
    return rows.map((r) => dec(r.cost));
  }

  async labels(groupBy: GroupBy, keys: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const ids = keys.filter((k) => k !== NONE_KEY);
    if (ids.length === 0) return new Map<string, string>();
    if (groupBy === 'repo') {
      const rows = await this.db.fleetRepo.findMany({ where: { id: { in: ids } }, select: { id: true, owner: true, name: true } });
      return new Map(rows.map((r): [string, string] => [r.id, `${r.owner}/${r.name}`]));
    }
    if (groupBy === 'runner') {
      const rows = await this.db.runner.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
      return new Map(rows.map((r): [string, string] => [r.id, r.name]));
    }
    if (groupBy === 'project') {
      const rows = await this.db.project.findMany({ where: { id: { in: ids } }, select: { id: true, slug: true } });
      return new Map(rows.map((r): [string, string] => [r.id, r.slug]));
    }
    return new Map<string, string>();
  }

  async storyStats(projectId: string, from: Date, to: Date): Promise<StoryStatsRow> {
    const [r] = await this.db.$queryRaw<Raw[]>(Prisma.sql`
      SELECT COUNT(*) AS "stories", COUNT(*) FILTER (WHERE s."firstPassSuccess") AS "firstPass", SUM(s."attempts") AS "attempts"
      FROM "FleetStoryResult" s
      WHERE s."projectId" = ${projectId} AND s."completedAt" >= ${from} AND s."completedAt" < ${to}`);
    return { stories: num(r.stories), firstPass: num(r.firstPass), attempts: num(r.attempts) };
  }

  async firstPassCells(projectId: string, w: AnalyticsWindow): Promise<FirstPassCell[]> {
    const rows = await this.db.$queryRaw<Raw[]>(Prisma.sql`
      SELECT date_trunc(${TRUNC[w.bucket]}, s."completedAt") AS "t", COUNT(*) AS "stories",
        COUNT(*) FILTER (WHERE s."firstPassSuccess") AS "firstPass"
      FROM "FleetStoryResult" s
      WHERE s."projectId" = ${projectId} AND s."completedAt" >= ${w.from} AND s."completedAt" < ${w.to}
      GROUP BY 1 ORDER BY 1`);
    return rows.map((r) => ({ t: r.t as Date, stories: num(r.stories), firstPass: num(r.firstPass) }));
  }

  async reviewers(projectId: string, from: Date, to: Date): Promise<ReviewerRow[]> {
    const rows = await this.db.$queryRaw<Raw[]>(Prisma.sql`
      SELECT r."reviewer", COUNT(*) AS "runs", COUNT(*) FILTER (WHERE r."passed") AS "passed"
      FROM "FleetReviewResult" r
      WHERE r."projectId" = ${projectId} AND r."at" >= ${from} AND r."at" < ${to}
      GROUP BY 1 ORDER BY 1`);
    return rows.map((r) => ({ reviewer: r.reviewer as string, runs: num(r.runs), passed: num(r.passed) }));
  }

  async reviewerSeverities(projectId: string, from: Date, to: Date): Promise<ReviewerSeverityRow[]> {
    const rows = await this.db.$queryRaw<Raw[]>(Prisma.sql`
      SELECT r."reviewer", f.key AS "severity", SUM(CASE WHEN f.value ~ '^[0-9]{1,9}$' THEN f.value::int ELSE 0 END) AS "count"
      FROM "FleetReviewResult" r CROSS JOIN LATERAL ${SEVERITIES} f
      WHERE r."projectId" = ${projectId} AND r."at" >= ${from} AND r."at" < ${to}
      GROUP BY 1, 2 ORDER BY 1, 2`);
    return rows.map((r) => ({ reviewer: r.reviewer as string, severity: r.severity as string, count: num(r.count) }));
  }

  async finishResults(projectId: string, from: Date, to: Date): Promise<CountRow[]> {
    return this.countJobs(Prisma.sql`j."finishResult"`, projectId, from, to);
  }

  async escalationReasons(projectId: string, from: Date, to: Date): Promise<CountRow[]> {
    return this.countJobs(Prisma.sql`j."escalationReason"`, projectId, from, to);
  }

  /** Jobs grouped by one text column, attributed by finishedAt (spec §4.1). */
  private async countJobs(column: Prisma.Sql, projectId: string, from: Date, to: Date): Promise<CountRow[]> {
    const rows = await this.db.$queryRaw<Raw[]>(Prisma.sql`
      SELECT ${column} AS "value", COUNT(*) AS "count"
      FROM "FleetJob" j
      WHERE j."projectId" = ${projectId} AND j."finishedAt" >= ${from} AND j."finishedAt" < ${to} AND ${column} IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC, 1 ASC`);
    return rows.map((r) => ({ value: r.value as string, count: num(r.count) }));
  }

  async topStories(projectId: string, from: Date, to: Date, sort: StorySort, limit: number): Promise<StoryListRow[]> {
    const orderBy: Prisma.FleetStoryResultOrderByWithRelationInput[] = sort === 'attempts'
      ? [{ attempts: 'desc' }, { costUsd: 'desc' }, { id: 'asc' }]
      : [{ costUsd: 'desc' }, { id: 'asc' }];
    const rows = await this.db.fleetStoryResult.findMany({
      where: { projectId, completedAt: { gte: from, lt: to } }, orderBy, take: limit,
      select: {
        jobId: true, leaseEpoch: true, featureName: true, storyId: true, attempts: true, firstPassSuccess: true, success: true,
        costUsd: true, completedAt: true,
      },
    });
    return rows.map((r) => ({ ...r, costUsd: dec(r.costUsd) }));
  }

  async topJobs(projectId: string, from: Date, to: Date, limit: number): Promise<JobListRow[]> {
    const rows = await this.db.$queryRaw<Raw[]>(Prisma.sql`
      SELECT j."id" AS "jobId", j."command", j."feature" AS "featureName", j."state",
        (j."costSpentUsd" + j."costCarriedUsd") AS "cost", l."ledger", j."finishedAt"
      FROM "FleetJob" j
      LEFT JOIN LATERAL (
        SELECT SUM(i."ledgerCostUsd") AS "ledger" FROM "FleetBundleIngest" i
        WHERE i."jobId" = j."id" AND i."status" IN ('done', 'partial')
      ) l ON TRUE
      WHERE j."projectId" = ${projectId} AND j."finishedAt" >= ${from} AND j."finishedAt" < ${to}
      ORDER BY "cost" DESC, j."id" ASC
      LIMIT ${limit}`);
    return rows.map((r) => ({
      jobId: r.jobId as string, command: r.command as string, featureName: r.featureName as string, state: r.state as string,
      costUsd: dec(r.cost), ledgerCostUsd: decOrNull(r.ledger), finishedAt: r.finishedAt as Date | null,
    }));
  }

  async jobSlices(jobId: string, by: JobSliceBy): Promise<CostSliceRow[]> {
    const rows = await this.db.$queryRaw<Raw[]>(Prisma.sql`
      SELECT ${SLICE_KEY[by]} AS "key", SUM(e."costUsd") AS "cost", SUM(${TOKENS}) AS "tokens"
      FROM "FleetCostEvent" e
      WHERE e."jobId" = ${jobId}
      GROUP BY 1 ORDER BY "cost" DESC, "key" ASC`);
    return rows.map((r) => ({ key: r.key as string, costUsd: dec(r.cost), tokens: num(r.tokens) }));
  }

  async latestIngest(jobId: string): Promise<JobIngestRow | null> {
    const r = await this.db.fleetBundleIngest.findFirst({
      where: { jobId }, orderBy: [{ leaseEpoch: 'desc' }, { createdAt: 'desc' }],
      select: { leaseEpoch: true, status: true, files: true, ingestedAt: true, error: true, liveCostUsd: true, ledgerCostUsd: true },
    });
    if (!r) return null;
    return {
      leaseEpoch: r.leaseEpoch, status: r.status, files: (r.files ?? {}) as Record<string, string>, ingestedAt: r.ingestedAt, error: r.error,
      liveCostUsd: decOrNull(r.liveCostUsd), ledgerCostUsd: decOrNull(r.ledgerCostUsd),
    };
  }

  async jobStories(jobId: string, limit: number): Promise<JobStoryRow[]> {
    const rows = await this.db.fleetStoryResult.findMany({
      where: { jobId }, orderBy: [{ leaseEpoch: 'desc' }, { storyId: 'asc' }], take: limit,
      select: {
        leaseEpoch: true, featureName: true, storyId: true, attempts: true, firstPassSuccess: true, success: true, costUsd: true,
        durationMs: true, completedAt: true,
      },
    });
    return rows.map((r) => ({ ...r, costUsd: dec(r.costUsd) }));
  }

  async jobReviews(jobId: string, limit: number): Promise<JobReviewRow[]> {
    const rows = await this.db.fleetReviewResult.findMany({
      where: { jobId }, orderBy: [{ at: 'asc' }, { id: 'asc' }], take: limit,
      select: {
        leaseEpoch: true, storyId: true, reviewer: true, passed: true, failOpen: true, findingCount: true, findingsBySeverity: true,
        advisoryCount: true, at: true,
      },
    });
    return rows.map((r) => ({ ...r, findingsBySeverity: (r.findingsBySeverity ?? {}) as Record<string, number> }));
  }

  async ingestHealth(projectId: string, from: Date, to: Date): Promise<IngestHealthRow> {
    const [r] = await this.db.$queryRaw<Raw[]>(Prisma.sql`
      SELECT COUNT(*) FILTER (WHERE i."status" IN ('pending', 'running')) AS "pending",
        COUNT(*) FILTER (WHERE i."status" = 'failed') AS "failed"
      FROM "FleetBundleIngest" i JOIN "FleetJob" j ON j."id" = i."jobId"
      WHERE j."projectId" = ${projectId} AND j."finishedAt" >= ${from} AND j."finishedAt" < ${to}`);
    return { pending: num(r.pending), failed: num(r.failed) };
  }

  async findProjectSlug(projectId: string): Promise<string | null> {
    const project = await this.db.project.findUnique({ where: { id: projectId }, select: { slug: true } });
    return project ? project.slug : null;
  }

  async deleteRows({ projectId, before, now }: DeleteAnalyticsInput): Promise<DeletedCounts> {
    const scoped = (alias: 'c' | 's' | 'r'): Prisma.Sql =>
      (projectId === null ? Prisma.empty : Prisma.sql`AND ${Prisma.raw(alias)}."projectId" = ${projectId}`);
    const ingestRowsMarked = await this.db.$executeRaw(Prisma.sql`
      UPDATE "FleetBundleIngest"
      SET "files" = "files" || jsonb_build_object('deleted', ${before.toISOString()}::text), "updatedAt" = ${now}
      WHERE "jobId" IN (
        SELECT c."jobId" FROM "FleetCostEvent" c WHERE c."at" < ${before} ${scoped('c')}
        UNION SELECT s."jobId" FROM "FleetStoryResult" s JOIN "FleetJob" j ON j."id" = s."jobId"
          WHERE (s."completedAt" < ${before} OR (s."completedAt" IS NULL AND j."finishedAt" < ${before})) ${scoped('s')}
        UNION SELECT r."jobId" FROM "FleetReviewResult" r WHERE r."at" < ${before} ${scoped('r')}
      )`);
    const project = projectId === null ? {} : { projectId };
    const costEvents = await this.db.fleetCostEvent.deleteMany({ where: { ...project, at: { lt: before } } });
    const stories = await this.db.fleetStoryResult.deleteMany({
      where: { ...project, OR: [{ completedAt: { lt: before } }, { completedAt: null, job: { finishedAt: { lt: before } } }] },
    });
    const reviews = await this.db.fleetReviewResult.deleteMany({ where: { ...project, at: { lt: before } } });
    return { costEvents: costEvents.count, stories: stories.count, reviews: reviews.count, ingestRowsMarked };
  }
}

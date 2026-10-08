import type { Prisma } from '../../../generated/prisma/client';

export type Bucket = 'day' | 'week' | 'month';
export const BUCKETS: readonly Bucket[] = ['day', 'week', 'month'];

export type ProjectGroupBy = 'model' | 'stage' | 'role' | 'repo' | 'runner' | 'feature' | 'story';
export const PROJECT_GROUPS: readonly ProjectGroupBy[] = ['model', 'stage', 'role', 'repo', 'runner', 'feature', 'story'];
export type GroupBy = ProjectGroupBy | 'project';
export const ADMIN_GROUPS: readonly GroupBy[] = [...PROJECT_GROUPS, 'project'];

export type StorySort = 'cost' | 'attempts';
export const STORY_SORTS: readonly StorySort[] = ['cost', 'attempts'];
export type JobSort = 'cost';
export const JOB_SORTS: readonly JobSort[] = ['cost'];
export type JobSliceBy = 'stage' | 'role' | 'model';

/** Spec §4.1-4.2 and D383. */
export const ANALYTICS_LIMITS = {
  defaultWindowDays: 30,
  maxWindowDays: 366,
  dayBucketMaxDays: 31,
  weekBucketMaxDays: 182,
  seriesKeep: 12,
  listDefault: 20,
  listMax: 50,
  topReasons: 10,
  reasonText: 200,
  jobDetailRows: 500,
} as const;

/** D377: the key of a null dimension (role, runner, story). */
export const NONE_KEY = '(none)';
/** D377: the key of the folded series. */
export const OTHER_KEY = 'other';

/** Half-open [from, to) (D378). */
export interface AnalyticsWindow {
  from: Date;
  to: Date;
  bucket: Bucket;
}

/** One (key, bucket) spend cell; money stays unrounded until the response (A7). */
export interface SpendCell {
  key: string;
  t: Date;
  costUsd: Prisma.Decimal;
  tokens: number;
}

export const ANALYTICS_REPOSITORY = Symbol('ANALYTICS_REPOSITORY');

/** `projectId: null` = every project (global admin). */
export interface AnalyticsScope {
  projectId: string | null;
}

export interface SpendTotalsRow {
  costUsd: Prisma.Decimal;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  jobs: number;
}

export interface StoryStatsRow {
  stories: number;
  firstPass: number;
  attempts: number;
}

export interface FirstPassCell {
  t: Date;
  stories: number;
  firstPass: number;
}

export interface ReviewerRow {
  reviewer: string;
  runs: number;
  passed: number;
}

export interface ReviewerSeverityRow {
  reviewer: string;
  severity: string;
  count: number;
}

/** A grouped count of one text column (finish result, escalation reason). */
export interface CountRow {
  value: string;
  count: number;
}

export interface StoryListRow {
  jobId: string;
  leaseEpoch: number;
  featureName: string;
  storyId: string;
  attempts: number;
  firstPassSuccess: boolean;
  success: boolean;
  costUsd: Prisma.Decimal;
  completedAt: Date | null;
}

export interface JobListRow {
  jobId: string;
  command: string;
  featureName: string;
  state: string;
  /** costSpentUsd + costCarriedUsd (D382). */
  costUsd: Prisma.Decimal;
  /** Sum over the job's done/partial ingest rows; null when none (D382). */
  ledgerCostUsd: Prisma.Decimal | null;
  finishedAt: Date | null;
}

export interface CostSliceRow {
  key: string;
  costUsd: Prisma.Decimal;
  tokens: number;
}

export interface JobIngestRow {
  leaseEpoch: number;
  status: string;
  files: Record<string, string>;
  ingestedAt: Date | null;
  error: string | null;
  liveCostUsd: Prisma.Decimal | null;
  ledgerCostUsd: Prisma.Decimal | null;
}

export interface JobStoryRow {
  leaseEpoch: number;
  featureName: string;
  storyId: string;
  attempts: number;
  firstPassSuccess: boolean;
  success: boolean;
  costUsd: Prisma.Decimal;
  durationMs: number | null;
  completedAt: Date | null;
}

export interface JobReviewRow {
  leaseEpoch: number;
  storyId: string | null;
  reviewer: string;
  passed: boolean;
  failOpen: boolean;
  findingCount: number;
  findingsBySeverity: Record<string, number>;
  advisoryCount: number;
  at: Date;
}

/** D388: ingest rows by status group. */
export interface IngestHealthRow {
  /** pending + running */
  pending: number;
  failed: number;
}

/** Spec §4.1-4.2: SQL GROUP BY over indexed columns; money unrounded. */
export interface IAnalyticsReadRepository {
  spendCells(scope: AnalyticsScope, w: AnalyticsWindow, groupBy: GroupBy): Promise<SpendCell[]>;
  spendTotals(scope: AnalyticsScope, from: Date, to: Date): Promise<SpendTotalsRow>;
  /** D388: one unrounded spend sum per job with a cost event in the window (the median's input). */
  jobCostSums(scope: AnalyticsScope, from: Date, to: Date): Promise<Prisma.Decimal[]>;
  /** D377: display names for repo, runner and project keys; other dimensions get an empty map. */
  labels(groupBy: GroupBy, keys: readonly string[]): Promise<ReadonlyMap<string, string>>;
  storyStats(projectId: string, from: Date, to: Date): Promise<StoryStatsRow>;
  firstPassCells(projectId: string, w: AnalyticsWindow): Promise<FirstPassCell[]>;
  reviewers(projectId: string, from: Date, to: Date): Promise<ReviewerRow[]>;
  reviewerSeverities(projectId: string, from: Date, to: Date): Promise<ReviewerSeverityRow[]>;
  finishResults(projectId: string, from: Date, to: Date): Promise<CountRow[]>;
  escalationReasons(projectId: string, from: Date, to: Date): Promise<CountRow[]>;
  topStories(projectId: string, from: Date, to: Date, sort: StorySort, limit: number): Promise<StoryListRow[]>;
  topJobs(projectId: string, from: Date, to: Date, limit: number): Promise<JobListRow[]>;
  /** All attempts of the job, cost descending (D383). */
  jobSlices(jobId: string, by: JobSliceBy): Promise<CostSliceRow[]>;
  /** The ingest row of the job's highest leaseEpoch (D383). */
  latestIngest(jobId: string): Promise<JobIngestRow | null>;
  jobStories(jobId: string, limit: number): Promise<JobStoryRow[]>;
  jobReviews(jobId: string, limit: number): Promise<JobReviewRow[]>;
  /** D388: ingest rows of the project's jobs finished in [from, to). */
  ingestHealth(projectId: string, from: Date, to: Date): Promise<IngestHealthRow>;
}

export interface DeleteAnalyticsInput {
  /** null = every project (D384). */
  projectId: string | null;
  before: Date;
  now: Date;
}

export interface DeletedCounts {
  costEvents: number;
  stories: number;
  reviews: number;
  ingestRowsMarked: number;
}

export interface IAnalyticsRepository extends IAnalyticsReadRepository {
  findProjectSlug(projectId: string): Promise<string | null>;
  /**
   * Spec §4.3, D384: marks the ingest rows of every job that loses rows, then deletes cost events and reviews by
   * `at`, stories by `completedAt` (or the job's `finishedAt` when null), all older than `before`. Call inside a
   * transaction.
   */
  deleteRows(input: DeleteAnalyticsInput): Promise<DeletedCounts>;
}

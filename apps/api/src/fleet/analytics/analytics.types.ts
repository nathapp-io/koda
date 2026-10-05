import type { Bucket, GroupBy, StorySort } from './domain/analytics.domain';

/** Inputs after DTO validation (spec §4.1). */
export interface WindowInput {
  from?: string;
  to?: string;
  bucket?: Bucket;
}
export interface SpendInput extends WindowInput {
  groupBy?: GroupBy;
}
export interface ListInput {
  from?: string;
  to?: string;
  limit?: number;
}
export interface StoriesInput extends ListInput {
  sort?: StorySort;
}
export interface DeleteInput {
  before: string;
  projectId?: string;
  confirm: string;
}

/** Response shapes (spec §4.2-4.3 with D377-D384). Money is a 4-place string (A7). */
export interface WindowView {
  from: string;
  to: string;
}
export interface SpendPointView {
  t: string;
  costUsd: string;
  tokens: number;
}
export interface SpendSeriesView {
  key: string;
  label: string;
  folded: boolean;
  costUsd: string;
  tokens: number;
  points: SpendPointView[];
}
export interface SpendTotalsView {
  costUsd: string;
  tokens: number;
  cacheShare: number | null;
  jobs: number;
}
export interface SpendView {
  window: WindowView;
  bucket: Bucket;
  groupBy: GroupBy;
  totals: SpendTotalsView;
  series: SpendSeriesView[];
}
export interface ReviewerView {
  reviewer: string;
  runs: number;
  passRate: number | null;
  findingsBySeverity: Record<string, number>;
}
export interface FinishOutcomesView {
  opened: number;
  promoted: number;
  escalated: number;
  skipped: number;
  other: number;
}
export interface ReasonView {
  reason: string;
  count: number;
}
export interface FirstPassPointView {
  t: string;
  rate: number | null;
}
export interface QualityView {
  window: WindowView;
  bucket: Bucket;
  stories: number;
  firstPassRate: number | null;
  avgAttempts: number | null;
  reviewByReviewer: ReviewerView[];
  finishOutcomes: FinishOutcomesView;
  topEscalationReasons: ReasonView[];
  firstPassSeries: FirstPassPointView[];
}
export interface StoryRowView {
  jobId: string;
  leaseEpoch: number;
  featureName: string;
  storyId: string;
  attempts: number;
  firstPassSuccess: boolean;
  success: boolean;
  costUsd: string;
  completedAt: string | null;
}
export interface StoriesView {
  window: WindowView;
  rows: StoryRowView[];
}
export interface JobRowView {
  jobId: string;
  command: string;
  featureName: string;
  state: string;
  costUsd: string;
  ledgerCostUsd: string | null;
  driftUsd: string | null;
  finishedAt: string | null;
}
export interface JobsView {
  window: WindowView;
  rows: JobRowView[];
}
export interface CostSliceView {
  key: string;
  costUsd: string;
  tokens: number;
}
export interface JobIngestView {
  leaseEpoch: number;
  status: string;
  files: Record<string, string>;
  ingestedAt: string | null;
  error: string | null;
}
export interface JobStoryView {
  leaseEpoch: number;
  featureName: string;
  storyId: string;
  attempts: number;
  firstPassSuccess: boolean;
  success: boolean;
  costUsd: string;
  durationMs: number | null;
  completedAt: string | null;
}
export interface JobReviewView {
  leaseEpoch: number;
  storyId: string | null;
  reviewer: string;
  passed: boolean;
  failOpen: boolean;
  findingCount: number;
  findingsBySeverity: Record<string, number>;
  advisoryCount: number;
  at: string;
}
export interface JobAnalyticsView {
  jobId: string;
  ingest: JobIngestView | null;
  byStage: CostSliceView[];
  byRole: CostSliceView[];
  byModel: CostSliceView[];
  stories: JobStoryView[];
  reviews: JobReviewView[];
  liveCostUsd: string | null;
  ledgerCostUsd: string | null;
  corrected: boolean;
}
export interface DeletedView {
  projectId: string | null;
  before: string;
  costEvents: number;
  stories: number;
  reviews: number;
  ingestRowsMarked: number;
}

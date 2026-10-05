/**
 * Fleet S2b analytics wire types (hand-written: the web has no generated client). Mirrors
 * apps/api/src/fleet/analytics/analytics.types.ts and the ingest DTOs. Money is a 4-place string (A7).
 */

export type AnalyticsBucket = 'day' | 'week' | 'month'
export type ProjectGroupBy = 'model' | 'stage' | 'role' | 'repo' | 'runner' | 'feature' | 'story'
export type AdminGroupBy = ProjectGroupBy | 'project'
export const PROJECT_GROUPS: readonly ProjectGroupBy[] = ['model', 'stage', 'role', 'repo', 'runner', 'feature', 'story']
export const ADMIN_GROUPS: readonly AdminGroupBy[] = [...PROJECT_GROUPS, 'project']

export interface AnalyticsWindowDto { from: string; to: string }

export interface SpendPointDto { t: string; costUsd: string; tokens: number }

export interface SpendSeriesDto {
  key: string
  label: string
  /** True only for the `other` fold (D377). */
  folded: boolean
  costUsd: string
  tokens: number
  points: SpendPointDto[]
}

export interface SpendTotalsDto {
  costUsd: string
  tokens: number
  cacheShare: number | null
  jobs: number
  medianJobCostUsd: string | null
}

export interface SpendAnalyticsDto {
  window: AnalyticsWindowDto
  bucket: AnalyticsBucket
  groupBy: AdminGroupBy
  totals: SpendTotalsDto
  series: SpendSeriesDto[]
}

export interface ReviewerQualityDto {
  reviewer: string
  runs: number
  passRate: number | null
  findingsBySeverity: Record<string, number>
}

export type FinishOutcome = 'opened' | 'promoted' | 'escalated' | 'skipped' | 'other'
export const FINISH_OUTCOMES: readonly FinishOutcome[] = ['opened', 'promoted', 'escalated', 'skipped', 'other']
export type FinishOutcomesDto = Record<FinishOutcome, number>

export interface QualityAnalyticsDto {
  window: AnalyticsWindowDto
  bucket: AnalyticsBucket
  stories: number
  firstPassRate: number | null
  avgAttempts: number | null
  reviewByReviewer: ReviewerQualityDto[]
  finishOutcomes: FinishOutcomesDto
  topEscalationReasons: Array<{ reason: string; count: number }>
  firstPassSeries: Array<{ t: string; rate: number | null }>
}

export interface StoryAnalyticsRowDto {
  jobId: string
  leaseEpoch: number
  featureName: string
  storyId: string
  attempts: number
  firstPassSuccess: boolean
  success: boolean
  costUsd: string
  completedAt: string | null
}

export interface StoriesAnalyticsDto { window: AnalyticsWindowDto; rows: StoryAnalyticsRowDto[] }

export interface JobAnalyticsRowDto {
  jobId: string
  command: string
  featureName: string
  state: string
  costUsd: string
  ledgerCostUsd: string | null
  driftUsd: string | null
  finishedAt: string | null
}

export interface JobsAnalyticsDto { window: AnalyticsWindowDto; rows: JobAnalyticsRowDto[] }

export interface IngestHealthDto { window: AnalyticsWindowDto; pending: number; failed: number }

export interface CostSliceDto { key: string; costUsd: string; tokens: number }

export type IngestStatus = 'pending' | 'running' | 'done' | 'partial' | 'failed'
export const INGEST_STATUSES: readonly IngestStatus[] = ['pending', 'running', 'done', 'partial', 'failed']

export interface JobIngestDto {
  leaseEpoch: number
  status: IngestStatus
  /** cost, metrics, review, finish -> done | absent | capped | partial | skipped:vN | invalid | oversized; plus `deleted`. */
  files: Record<string, string>
  ingestedAt: string | null
  error: string | null
}

export interface JobStoryDto {
  leaseEpoch: number
  featureName: string
  storyId: string
  attempts: number
  firstPassSuccess: boolean
  success: boolean
  costUsd: string
  durationMs: number | null
  completedAt: string | null
}

export interface JobReviewDto {
  leaseEpoch: number
  storyId: string | null
  reviewer: string
  passed: boolean
  failOpen: boolean
  findingCount: number
  findingsBySeverity: Record<string, number>
  advisoryCount: number
  at: string
}

export interface JobAnalyticsDto {
  jobId: string
  ingest: JobIngestDto | null
  byStage: CostSliceDto[]
  byRole: CostSliceDto[]
  byModel: CostSliceDto[]
  stories: JobStoryDto[]
  reviews: JobReviewDto[]
  liveCostUsd: string | null
  ledgerCostUsd: string | null
  /** The job was corrected COMPLETED -> ESCALATED from its finish-audit (S2b §3.2). */
  corrected: boolean
}

export interface IngestRowDto {
  id: string
  jobId: string
  leaseEpoch: number
  projectId: string
  status: IngestStatus
  attempts: number
  parserVersion: number
  files: Record<string, string>
  error: string | null
  ingestedAt: string | null
  updatedAt: string
}

export interface IngestQueuedDto { queued: number }

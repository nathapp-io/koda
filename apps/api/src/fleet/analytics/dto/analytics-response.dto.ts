import { ApiProperty } from '@nestjs/swagger';
import type {
  CostSliceView, DeletedView, FinishOutcomesView, FirstPassPointView, IngestHealthView, JobAnalyticsView, JobIngestView, JobReviewView,
  JobRowView, JobsView, JobStoryView, QualityView, ReasonView, ReviewerView, SpendPointView, SpendSeriesView, SpendTotalsView, SpendView,
  StoriesView, StoryRowView, WindowView,
} from '../analytics.types';
import { ADMIN_GROUPS, Bucket, BUCKETS, GroupBy } from '../domain/analytics.domain';

const USD = { example: '0.1234', description: 'USD, exactly 4 places (A7)' };
const COUNTS = { type: 'object', additionalProperties: { type: 'integer' } } as const;

export class AnalyticsWindowDto implements WindowView {
  @ApiProperty({ format: 'date-time' }) from: string;
  @ApiProperty({ format: 'date-time' }) to: string;
}

export class SpendPointDto implements SpendPointView {
  @ApiProperty({ format: 'date-time', description: 'Bucket start (UTC)' }) t: string;
  @ApiProperty(USD) costUsd: string;
  @ApiProperty() tokens: number;
}

export class SpendSeriesDto implements SpendSeriesView {
  @ApiProperty({ description: 'Group key; `(none)` for an empty dimension; `other` when folded' }) key: string;
  @ApiProperty({ description: 'repo owner/name, runner name, project slug, else the key' }) label: string;
  @ApiProperty({ description: 'True only for the series that folds every key beyond the top `top` (default 12)' }) folded: boolean;
  @ApiProperty(USD) costUsd: string;
  @ApiProperty() tokens: number;
  @ApiProperty({ type: [SpendPointDto] }) points: SpendPointDto[];
}

export class SpendTotalsDto implements SpendTotalsView {
  @ApiProperty(USD) costUsd: string;
  @ApiProperty() tokens: number;
  @ApiProperty({ type: Number, nullable: true, description: 'cacheRead / (input + cacheRead), 4 places' }) cacheShare: number | null;
  @ApiProperty() jobs: number;
  @ApiProperty({ type: String, nullable: true, example: '0.1234', description: 'Median per-job spend in the window (each job counts only its spend inside the window), 4 places; null with no jobs (D388)' })
  medianJobCostUsd: string | null;
}

export class SpendAnalyticsDto implements SpendView {
  @ApiProperty({ type: AnalyticsWindowDto }) window: AnalyticsWindowDto;
  @ApiProperty({ enum: BUCKETS }) bucket: Bucket;
  @ApiProperty({ enum: ADMIN_GROUPS }) groupBy: GroupBy;
  @ApiProperty({ type: SpendTotalsDto }) totals: SpendTotalsDto;
  @ApiProperty({ type: [SpendSeriesDto] }) series: SpendSeriesDto[];
}

export class ReviewerQualityDto implements ReviewerView {
  @ApiProperty() reviewer: string;
  @ApiProperty() runs: number;
  @ApiProperty({ type: Number, nullable: true }) passRate: number | null;
  @ApiProperty(COUNTS) findingsBySeverity: Record<string, number>;
}

export class FinishOutcomesDto implements FinishOutcomesView {
  @ApiProperty() opened: number;
  @ApiProperty() promoted: number;
  @ApiProperty() escalated: number;
  @ApiProperty() skipped: number;
  @ApiProperty() other: number;
}

export class EscalationReasonDto implements ReasonView {
  @ApiProperty() reason: string;
  @ApiProperty() count: number;
}

export class FirstPassPointDto implements FirstPassPointView {
  @ApiProperty({ format: 'date-time' }) t: string;
  @ApiProperty({ type: Number, nullable: true }) rate: number | null;
}

export class QualityAnalyticsDto implements QualityView {
  @ApiProperty({ type: AnalyticsWindowDto }) window: AnalyticsWindowDto;
  @ApiProperty({ enum: BUCKETS }) bucket: Bucket;
  @ApiProperty() stories: number;
  @ApiProperty({ type: Number, nullable: true }) firstPassRate: number | null;
  @ApiProperty({ type: Number, nullable: true }) avgAttempts: number | null;
  @ApiProperty({ type: [ReviewerQualityDto] }) reviewByReviewer: ReviewerQualityDto[];
  @ApiProperty({ type: FinishOutcomesDto }) finishOutcomes: FinishOutcomesDto;
  @ApiProperty({ type: [EscalationReasonDto] }) topEscalationReasons: EscalationReasonDto[];
  @ApiProperty({ type: [FirstPassPointDto] }) firstPassSeries: FirstPassPointDto[];
}

export class StoryAnalyticsRowDto implements StoryRowView {
  @ApiProperty() jobId: string;
  @ApiProperty() leaseEpoch: number;
  @ApiProperty() featureName: string;
  @ApiProperty() storyId: string;
  @ApiProperty() attempts: number;
  @ApiProperty() firstPassSuccess: boolean;
  @ApiProperty() success: boolean;
  @ApiProperty(USD) costUsd: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) completedAt: string | null;
}

export class StoriesAnalyticsDto implements StoriesView {
  @ApiProperty({ type: AnalyticsWindowDto }) window: AnalyticsWindowDto;
  @ApiProperty({ type: [StoryAnalyticsRowDto] }) rows: StoryAnalyticsRowDto[];
}

export class JobAnalyticsRowDto implements JobRowView {
  @ApiProperty() jobId: string;
  @ApiProperty() command: string;
  @ApiProperty() featureName: string;
  @ApiProperty() state: string;
  @ApiProperty({ ...USD, description: 'costSpentUsd + costCarriedUsd' }) costUsd: string;
  @ApiProperty({ type: String, nullable: true, description: 'Sum of ingested cost ledgers; null before ingest' }) ledgerCostUsd: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'ledger - cost' }) driftUsd: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) finishedAt: string | null;
}

export class JobsAnalyticsDto implements JobsView {
  @ApiProperty({ type: AnalyticsWindowDto }) window: AnalyticsWindowDto;
  @ApiProperty({ type: [JobAnalyticsRowDto] }) rows: JobAnalyticsRowDto[];
}

export class IngestHealthDto implements IngestHealthView {
  @ApiProperty({ type: AnalyticsWindowDto }) window: AnalyticsWindowDto;
  @ApiProperty({ description: 'Ingest rows pending or running, of jobs finished in the window' }) pending: number;
  @ApiProperty({ description: 'Ingest rows that failed after their retries' }) failed: number;
}

export class CostSliceDto implements CostSliceView {
  @ApiProperty() key: string;
  @ApiProperty(USD) costUsd: string;
  @ApiProperty() tokens: number;
}

export class JobIngestSummaryDto implements JobIngestView {
  @ApiProperty() leaseEpoch: number;
  @ApiProperty({ enum: ['pending', 'running', 'done', 'partial', 'failed'] }) status: string;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } }) files: Record<string, string>;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) ingestedAt: string | null;
  @ApiProperty({ type: String, nullable: true }) error: string | null;
}

export class JobStoryResultDto implements JobStoryView {
  @ApiProperty() leaseEpoch: number;
  @ApiProperty() featureName: string;
  @ApiProperty() storyId: string;
  @ApiProperty() attempts: number;
  @ApiProperty() firstPassSuccess: boolean;
  @ApiProperty() success: boolean;
  @ApiProperty(USD) costUsd: string;
  @ApiProperty({ type: Number, nullable: true }) durationMs: number | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) completedAt: string | null;
}

export class JobReviewResultDto implements JobReviewView {
  @ApiProperty() leaseEpoch: number;
  @ApiProperty({ type: String, nullable: true }) storyId: string | null;
  @ApiProperty() reviewer: string;
  @ApiProperty() passed: boolean;
  @ApiProperty() failOpen: boolean;
  @ApiProperty() findingCount: number;
  @ApiProperty(COUNTS) findingsBySeverity: Record<string, number>;
  @ApiProperty() advisoryCount: number;
  @ApiProperty({ format: 'date-time' }) at: string;
}

export class JobAnalyticsDto implements JobAnalyticsView {
  @ApiProperty() jobId: string;
  @ApiProperty({ type: JobIngestSummaryDto, nullable: true, description: 'The latest attempt with an ingest row' }) ingest: JobIngestSummaryDto | null;
  @ApiProperty({ type: [CostSliceDto] }) byStage: CostSliceDto[];
  @ApiProperty({ type: [CostSliceDto] }) byRole: CostSliceDto[];
  @ApiProperty({ type: [CostSliceDto] }) byModel: CostSliceDto[];
  @ApiProperty({ type: [JobStoryResultDto] }) stories: JobStoryResultDto[];
  @ApiProperty({ type: [JobReviewResultDto] }) reviews: JobReviewResultDto[];
  @ApiProperty({ type: String, nullable: true }) liveCostUsd: string | null;
  @ApiProperty({ type: String, nullable: true }) ledgerCostUsd: string | null;
  @ApiProperty({ description: 'The state was corrected from finish-audit (spec §3.2)' }) corrected: boolean;
}

export class AnalyticsDeletedDto implements DeletedView {
  @ApiProperty({ type: String, nullable: true }) projectId: string | null;
  @ApiProperty({ format: 'date-time' }) before: string;
  @ApiProperty() costEvents: number;
  @ApiProperty() stories: number;
  @ApiProperty() reviews: number;
  @ApiProperty() ingestRowsMarked: number;
}

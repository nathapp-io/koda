import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { MisfitReason } from '../../jobs/placement-rules';
import type {
  DashboardActiveJobView, DashboardCountsView, DashboardCredentialView, DashboardRecentJobView, DashboardRunnerView, DashboardView,
} from '../dashboard-view';
import {
  ATTENTION_KINDS, AttentionItem, AttentionKind, AttentionReason, CONDITION_TYPES, ConditionType, CREDENTIAL_WHY, CredentialWhy, MISFIT_REASONS,
  RunnerCondition, SEVERITIES, Severity, UNPLACEABLE_VERDICTS, UnplaceableVerdict,
} from '../dashboard.types';

const USD = { example: '0.42', description: 'Decimal as string' };
const DATE = { format: 'date-time' } as const;
const NULLABLE_DATE = { type: String, format: 'date-time', nullable: true } as const;
const NULLABLE_STRING = { type: String, nullable: true } as const;

export class DashboardCountsDto implements DashboardCountsView {
  @ApiProperty() runnersOnline: number;
  @ApiProperty() runnersTotal: number;
  @ApiProperty({ description: 'QUEUED jobs in scope (not capped)' }) queued: number;
  @ApiProperty({ description: 'ASSIGNED + RUNNING + UPLOADING jobs in scope (not capped)' }) running: number;
  @ApiProperty() attention: number;
}

export class DashboardCredentialDto implements DashboardCredentialView {
  @ApiProperty() providerId: string;
  @ApiProperty({ description: "nax's verdict (ignores OAuth access-token expiry)" }) available: boolean;
  @ApiProperty({ type: String, enum: ['api-key', 'oauth'], nullable: true }) kind: 'api-key' | 'oauth' | null;
  @ApiProperty(NULLABLE_DATE) expiresAt: string | null;
  @ApiProperty() expired: boolean;
}

export class DashboardRunnerDto implements DashboardRunnerView {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty({ enum: ['darwin', 'linux'] }) os: string;
  @ApiProperty({ enum: ['arm64', 'x64'] }) arch: string;
  @ApiProperty({ type: [String] }) labels: string[];
  @ApiProperty() enabled: boolean;
  @ApiProperty({ description: 'Synced within FLEET_RUNNER_OFFLINE_SEC' }) online: boolean;
  @ApiProperty(DATE) lastSeenAt: string;
  @ApiProperty() capacity: number;
  @ApiProperty({ description: 'Runner-held jobs of every project' }) activeJobs: number;
  @ApiProperty({ ...NULLABLE_STRING, description: 'Global admin scope only; null in project scope or when capabilities are unreadable' }) naxVersion: string | null;
  @ApiProperty({ ...NULLABLE_STRING, description: 'Global admin scope only' }) daemonVersion: string | null;
  @ApiProperty({ type: [DashboardCredentialDto], description: 'Global admin scope only; empty in project scope' }) credentials: DashboardCredentialDto[];
}

export class DashboardActiveJobDto implements DashboardActiveJobView {
  @ApiProperty() id: string;
  @ApiProperty() projectSlug: string;
  @ApiProperty({ example: 'acme/app' }) repo: string;
  @ApiProperty() feature: string;
  @ApiProperty({ enum: ['RUN', 'PLAN'] }) command: string;
  @ApiProperty({ enum: ['QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING'] }) state: string;
  @ApiProperty(NULLABLE_STRING) runnerId: string | null;
  @ApiProperty(NULLABLE_STRING) runnerName: string | null;
  @ApiProperty(NULLABLE_STRING) currentStoryId: string | null;
  @ApiProperty(NULLABLE_STRING) currentPhase: string | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Stories with status passed; null when unknown or truncated' }) storiesDone: number | null;
  @ApiProperty({ type: Number, nullable: true }) storiesTotal: number | null;
  @ApiProperty(USD) costSpentUsd: string;
  @ApiProperty(USD) maxCostUsd: string;
  @ApiProperty(DATE) queuedAt: string;
  @ApiProperty(NULLABLE_DATE) startedAt: string | null;
  @ApiProperty(NULLABLE_DATE) lastHeartbeatAt: string | null;
  @ApiProperty() pendingApprovals: number;
}

export class DashboardRecentJobDto implements DashboardRecentJobView {
  @ApiProperty() id: string;
  @ApiProperty() projectSlug: string;
  @ApiProperty({ example: 'acme/app' }) repo: string;
  @ApiProperty() feature: string;
  @ApiProperty({ enum: ['RUN', 'PLAN'] }) command: string;
  @ApiProperty({ enum: ['COMPLETED', 'FAILED', 'ESCALATED', 'CRASHED', 'CANCELLED'] }) state: string;
  @ApiProperty(NULLABLE_STRING) stateReason: string | null;
  @ApiProperty(NULLABLE_STRING) runnerName: string | null;
  @ApiProperty(USD) costSpentUsd: string;
  @ApiProperty(NULLABLE_DATE) startedAt: string | null;
  @ApiProperty(DATE) finishedAt: string;
  @ApiProperty(NULLABLE_STRING) resultPrUrl: string | null;
}

export class AttentionReasonDto implements AttentionReason {
  @ApiProperty() runnerName: string;
  @ApiProperty({ enum: MISFIT_REASONS }) reason: MisfitReason;
}

export class RunnerConditionDto implements RunnerCondition {
  @ApiProperty({ enum: CONDITION_TYPES, description: 'Project scope sees only offline and configuration' }) type: ConditionType;
  @ApiPropertyOptional({ description: 'offline: runner-held jobs of every project' }) jobsHeld?: number;
  @ApiPropertyOptional({ description: 'credential (global admin scope only)' }) providerId?: string;
  @ApiPropertyOptional({ enum: CREDENTIAL_WHY }) why?: CredentialWhy;
  @ApiPropertyOptional({ description: 'stale_nax: this runner (global admin scope only)' }) version?: string;
  @ApiPropertyOptional({ description: 'stale_nax: newest online core version (global admin scope only)' }) latest?: string;
  @ApiPropertyOptional({ description: 'interaction: the plugin nax could not start (global admin scope only)' }) plugin?: string;
  @ApiPropertyOptional({ description: 'interaction: nax error code (global admin scope only)' }) code?: string;
  @ApiPropertyOptional({ description: 'interaction: the profile; absent means the base config (global admin scope only)' }) profile?: string;
}

/** Spec §2: flat; fields beyond `since` belong to one kind each. Clients word it; the API sends no prose. */
export class AttentionItemDto implements AttentionItem {
  @ApiProperty({ description: '`${kind}:${subjectId}`, stable across polls' }) key: string;
  @ApiProperty({ enum: ATTENTION_KINDS }) kind: AttentionKind;
  @ApiProperty({ enum: SEVERITIES }) severity: Severity;
  @ApiProperty({ enum: ['job', 'runner'] }) subjectType: 'job' | 'runner';
  @ApiProperty() subjectId: string;
  @ApiProperty({ description: 'Job feature or runner name' }) subjectName: string;
  @ApiProperty({ ...NULLABLE_STRING, description: 'null for runner items' }) projectSlug: string | null;
  @ApiProperty({ ...NULLABLE_DATE, description: 'When the condition started; null when unknown' }) since: string | null;
  @ApiPropertyOptional({ enum: ['starting', 'running'] }) stage?: 'starting' | 'running';
  @ApiPropertyOptional() silentSec?: number;
  @ApiPropertyOptional(NULLABLE_STRING) runnerName?: string | null;
  @ApiPropertyOptional() pending?: number;
  @ApiPropertyOptional() oldestSec?: number;
  @ApiPropertyOptional({ enum: UNPLACEABLE_VERDICTS }) verdict?: UnplaceableVerdict;
  @ApiPropertyOptional({ type: [AttentionReasonDto], description: 'At most 20, by runner name' }) reasons?: AttentionReasonDto[];
  @ApiPropertyOptional() reasonsTotal?: number;
  @ApiPropertyOptional({ type: [RunnerConditionDto] }) conditions?: RunnerConditionDto[];
}

export class FleetDashboardDto implements DashboardView {
  @ApiProperty({ ...DATE, description: 'Server time every age is measured against' }) generatedAt: string;
  @ApiProperty({ type: DashboardCountsDto }) counts: DashboardCountsDto;
  @ApiProperty({ type: [DashboardRunnerDto] }) runners: DashboardRunnerDto[];
  @ApiProperty({ type: [DashboardActiveJobDto], description: 'Oldest first, at most 200' }) activeJobs: DashboardActiveJobDto[];
  @ApiProperty() activeTruncated: boolean;
  @ApiProperty({ type: [DashboardRecentJobDto], description: 'Finished in the last 24 h, newest first, at most 20' }) recentJobs: DashboardRecentJobDto[];
  @ApiProperty() recentTruncated: boolean;
  @ApiProperty({ type: [AttentionItemDto], description: 'Errors first, then oldest since' }) attention: AttentionItemDto[];
}

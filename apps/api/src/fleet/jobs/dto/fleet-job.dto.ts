import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { BashMode } from '../../common/protocol';
import { FleetJobTicketDto } from '../../tickets/dto/ticket-fleet-job.dto';
import type { FleetJobRecord } from '../domain/fleet-job.domain';
import type { MisfitReason } from '../placement-rules';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const STATES = ['QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING', 'COMPLETED', 'FAILED', 'ESCALATED', 'CRASHED', 'CANCELLED'];

export class FleetJobStoryDto {
  @ApiProperty() declare id: string;
  @ApiProperty() declare title: string;
  @ApiProperty({ description: "nax's story status (pending, in-progress, passed, failed, ...)" }) declare status: string;
  @ApiProperty() declare attempts: number;
  @ApiProperty({ type: [String] }) declare dependsOn: string[];
}

/** S2b (j) §1.3: nax post-run stage statuses, passed through (pending/running/passed/failed/skipped/not-run, ...). */
export class FleetJobPostRunDto {
  @ApiPropertyOptional({ maxLength: 32 }) declare acceptance?: string;
  @ApiPropertyOptional({ maxLength: 32 }) declare regression?: string;
  @ApiPropertyOptional({ maxLength: 32 }) declare finish?: string;
}

export class FleetJobDto {
  @ApiProperty() declare id: string;
  @ApiProperty() declare projectId: string;
  @ApiProperty() declare repoId: string;
  @ApiProperty() declare ref: string;
  @ApiProperty({ enum: ['RUN', 'PLAN'] }) declare command: 'RUN' | 'PLAN';
  @ApiProperty() declare feature: string;
  @ApiPropertyOptional({ type: String, nullable: true }) declare planFrom: string | null;
  @ApiProperty({ type: [String] }) declare profiles: string[];
  @ApiProperty({ type: String, description: 'Decimal as string' }) declare maxCostUsd: string;
  @ApiProperty({ enum: ['raw', 'gated', 'escalate'] }) declare bashMode: BashMode;
  @ApiProperty({ minimum: 30, maximum: 3600, description: 'S1.5: seconds a bash ask waits; used only when bashMode is not raw' })
  declare approvalTimeoutSec: number;
  @ApiProperty({ description: 'S1.5: pending bash approvals of this job' })
  declare pendingApprovals: number;
  @ApiProperty({ type: [String] }) declare selectorLabels: string[];
  @ApiPropertyOptional({ type: String, nullable: true }) declare pinnedRunnerId: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare runnerId: string | null;
  @ApiProperty() declare leaseEpoch: number;
  @ApiProperty({ enum: STATES }) declare state: string;
  @ApiPropertyOptional({ type: String, nullable: true }) declare stateReason: string | null;
  @ApiProperty() declare requestedById: string;
  @ApiProperty() declare queuedAt: string;
  @ApiPropertyOptional({ type: String, nullable: true }) declare assignedAt: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare startedAt: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare finishedAt: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare cancelRequestedAt: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare naxRunId: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare naxLogRunId: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare naxCostRunId: string | null;
  @ApiPropertyOptional({ type: Object, nullable: true }) declare progress: unknown;
  @ApiPropertyOptional({ type: String, nullable: true }) declare currentStoryId: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare currentPhase: string | null;
  @ApiProperty({ type: String, description: 'Decimal as string' }) declare costSpentUsd: string;
  @ApiPropertyOptional({ type: String, nullable: true }) declare lastHeartbeatAt: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare finishResult: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare escalationReason: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) declare exitCode: number | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare resultBranch: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare resultSha: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare resultPrUrl: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'pushed | none | failed:<reason> (S1b §1.1)' }) declare wipPush: string | null;
  @ApiPropertyOptional({ type: [FleetJobStoryDto], nullable: true, description: 'PRD stories in PRD order (S1b §1.2). Null on list pages (D149).' }) declare stories: FleetJobStoryDto[] | null;
  @ApiProperty({ description: 'True when the runner cut the story list to fit (S1b §1.2)' }) declare storiesTruncated: boolean;
  @ApiPropertyOptional({ type: FleetJobPostRunDto, nullable: true, description: 'nax post-run stage statuses (S2b (j)). Null when unknown and on list pages (D433).' })
  declare postRun: FleetJobPostRunDto | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'The schedule that dispatched the job (S1b §3.1)' }) declare scheduleId: string | null;
  @ApiProperty({ description: 'Schedule ticks absorbed into this job while it sat queued (S1b §3.2)' }) declare coalescedCount: number;
  @ApiPropertyOptional({ type: [FleetJobTicketDto], nullable: true, description: 'Linked tickets (fleet C9 §2.2). Null on list pages (D460).' })
  declare tickets: FleetJobTicketDto[] | null;

  /** Internal columns (runnerBootId, eventSeq, ackedRunnerSeq, attributedAt) stay server-side. */
  static from(r: FleetJobRecord, pendingApprovals = 0): FleetJobDto {
    return Object.assign(new FleetJobDto(), {
      id: r.id, projectId: r.projectId, repoId: r.repoId, ref: r.ref, command: r.command, feature: r.feature,
      planFrom: r.planFrom, profiles: r.profiles, maxCostUsd: r.maxCostUsd, bashMode: r.bashMode,
      approvalTimeoutSec: r.approvalTimeoutSec, pendingApprovals,
      selectorLabels: r.selectorLabels, pinnedRunnerId: r.pinnedRunnerId, runnerId: r.runnerId, leaseEpoch: r.leaseEpoch,
      state: r.state, stateReason: r.stateReason, requestedById: r.requestedById, queuedAt: r.queuedAt.toISOString(),
      assignedAt: iso(r.assignedAt), startedAt: iso(r.startedAt), finishedAt: iso(r.finishedAt),
      cancelRequestedAt: iso(r.cancelRequestedAt), naxRunId: r.naxRunId, naxLogRunId: r.naxLogRunId,
      naxCostRunId: r.naxCostRunId, progress: r.progress ?? null, currentStoryId: r.currentStoryId,
      currentPhase: r.currentPhase, costSpentUsd: r.costSpentUsd, lastHeartbeatAt: iso(r.lastHeartbeatAt),
      finishResult: r.finishResult, escalationReason: r.escalationReason, exitCode: r.exitCode,
      resultBranch: r.resultBranch, resultSha: r.resultSha, resultPrUrl: r.resultPrUrl, wipPush: r.wipPush,
      stories: r.stories, storiesTruncated: r.storiesTruncated, postRun: r.postRun,
      scheduleId: r.scheduleId, coalescedCount: r.coalescedCount, tickets: null,
    });
  }

  /** D149, D433: a list page leaves the story list and post-run stages out; `GET :id` carries them. */
  static summary(r: FleetJobRecord, pendingApprovals = 0): FleetJobDto {
    return Object.assign(FleetJobDto.from(r, pendingApprovals), { stories: null, storiesTruncated: false, postRun: null });
  }
}

export class PlacementMisfitDto {
  @ApiProperty() declare runnerId: string;
  @ApiProperty() declare name: string;
  @ApiProperty({ enum: ['disabled', 'offline', 'budget_paused', 'labels', 'executor', 'protocol', 'provider_missing', 'provider_unavailable', 'sandbox', 'interaction', 'tools', 'approvals_relay', 'busy_repo', 'capacity'] })
  declare reason: MisfitReason;
}

export class PlacementSummaryDto {
  @ApiProperty() declare assigned: boolean;
  @ApiPropertyOptional({ type: String, nullable: true }) declare runnerId: string | null;
  @ApiProperty({ type: [PlacementMisfitDto] }) declare misfits: PlacementMisfitDto[];
}

export class DispatchResultDto {
  @ApiProperty({ type: FleetJobDto }) declare job: FleetJobDto;
  @ApiProperty({ type: PlacementSummaryDto }) declare placement: PlacementSummaryDto;
}

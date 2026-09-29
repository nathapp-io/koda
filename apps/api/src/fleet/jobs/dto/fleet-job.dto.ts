import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { FleetJobRecord } from '../domain/fleet-job.domain';
import type { MisfitReason } from '../placement-rules';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const STATES = ['QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING', 'COMPLETED', 'FAILED', 'ESCALATED', 'CRASHED', 'CANCELLED'];

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
  @ApiProperty() declare bashMode: string;
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

  /** Internal columns (runnerBootId, eventSeq, ackedRunnerSeq, attributedAt) stay server-side. */
  static from(r: FleetJobRecord): FleetJobDto {
    return Object.assign(new FleetJobDto(), {
      id: r.id, projectId: r.projectId, repoId: r.repoId, ref: r.ref, command: r.command, feature: r.feature,
      planFrom: r.planFrom, profiles: r.profiles, maxCostUsd: r.maxCostUsd, bashMode: r.bashMode,
      selectorLabels: r.selectorLabels, pinnedRunnerId: r.pinnedRunnerId, runnerId: r.runnerId, leaseEpoch: r.leaseEpoch,
      state: r.state, stateReason: r.stateReason, requestedById: r.requestedById, queuedAt: r.queuedAt.toISOString(),
      assignedAt: iso(r.assignedAt), startedAt: iso(r.startedAt), finishedAt: iso(r.finishedAt),
      cancelRequestedAt: iso(r.cancelRequestedAt), naxRunId: r.naxRunId, naxLogRunId: r.naxLogRunId,
      naxCostRunId: r.naxCostRunId, progress: r.progress ?? null, currentStoryId: r.currentStoryId,
      currentPhase: r.currentPhase, costSpentUsd: r.costSpentUsd, lastHeartbeatAt: iso(r.lastHeartbeatAt),
      finishResult: r.finishResult, escalationReason: r.escalationReason, exitCode: r.exitCode,
      resultBranch: r.resultBranch, resultSha: r.resultSha, resultPrUrl: r.resultPrUrl,
    });
  }
}

export class PlacementMisfitDto {
  @ApiProperty() declare runnerId: string;
  @ApiProperty() declare name: string;
  @ApiProperty({ enum: ['disabled', 'offline', 'labels', 'executor', 'protocol', 'provider_missing', 'provider_unavailable', 'sandbox', 'tools', 'busy_repo', 'capacity'] })
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

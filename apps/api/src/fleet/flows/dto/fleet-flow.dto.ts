import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  FleetFlowApprovalMode,
  FleetFlowEntry,
  FleetFlowFeatureRecord,
  FleetFlowRecord,
} from '../domain/fleet-flow.domain';

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/**
 * The approval block of a flow. A decided flow carries its mode, approver and time; a PENDING flow has
 * no mode yet but the `fleet.flow.start` request it waits on is part of the record — `create` stores the
 * request id and nothing else — so that request answers as `REQUEST`, the mode a decision on it
 * persists. Only a flow with neither a mode nor a request (started by the thread's tick, which has no
 * request) answers `null`.
 */
function approvalOf(record: FleetFlowRecord): FleetFlowApprovalDto | null {
  const mode = record.approvalMode ?? (record.approvalRequestId === null ? null : 'REQUEST');
  if (mode === null) return null;
  return {
    mode,
    approverId: record.approverId,
    approvedAt: iso(record.approvedAt),
    approvalRequestId: record.approvalRequestId,
  };
}

export class FleetFlowPageDto {
  @ApiProperty({ type: () => [FleetFlowDto] }) declare records: FleetFlowDto[];
  @ApiProperty() declare total: number;
  @ApiProperty() declare current: number;
  @ApiProperty() declare size: number;
  @ApiProperty() declare hasNext: boolean;
  @ApiProperty() declare hasPrev: boolean;
}

export class FleetFlowCreatorDto {
  @ApiProperty({ enum: ['USER', 'AGENT'] }) declare type: 'USER' | 'AGENT';
  @ApiProperty() declare id: string;
}

export class FleetFlowRolesDto {
  @ApiProperty() declare reviewer: string;
  @ApiProperty() declare supervisor: string;
}

export class FleetFlowApprovalDto {
  @ApiProperty({ enum: ['REQUEST', 'PRE_APPROVED'] }) declare mode: FleetFlowApprovalMode;
  @ApiPropertyOptional({ type: String, nullable: true }) declare approverId: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare approvedAt: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare approvalRequestId: string | null;
}

export class FleetFlowQuestionDto {
  @ApiProperty() declare id: string;
  @ApiProperty() declare question: string;
}

export class FleetFlowAnswerDto {
  @ApiProperty() declare id: string;
  @ApiProperty() declare answer: string;
}

export class FleetFlowFeatureDto {
  @ApiProperty() declare feature: string;
  @ApiProperty() declare specPath: string;
  @ApiPropertyOptional({ type: String, nullable: true }) declare branch: string | null;
  @ApiProperty({ type: [String] }) declare dependsOn: string[];
  @ApiProperty() declare state: string;
  @ApiPropertyOptional({ type: String, nullable: true }) declare currentStep: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) declare prNumber: number | null;
  /** The review job the questions and the answers belong to: a later review replaces them. */
  @ApiPropertyOptional({ type: String, nullable: true }) declare questionsJobId: string | null;
  @ApiPropertyOptional({ type: () => [FleetFlowQuestionDto], nullable: true }) declare questions: FleetFlowQuestionDto[] | null;
  @ApiPropertyOptional({ type: () => [FleetFlowAnswerDto], nullable: true }) declare answers: FleetFlowAnswerDto[] | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare answeredAt: string | null;

  static from(feature: FleetFlowFeatureRecord): FleetFlowFeatureDto {
    return Object.assign(new FleetFlowFeatureDto(), {
      feature: feature.feature, specPath: feature.specPath, branch: feature.branch ?? null, dependsOn: feature.dependsOn ?? [],
      state: feature.state, currentStep: feature.currentStep, prNumber: feature.prNumber,
      questionsJobId: feature.questionsJobId ?? null,
      questions: feature.questions?.map((question) => ({ id: question.id, question: question.question })) ?? null,
      answers: feature.answers?.map((answer) => ({ id: answer.id, answer: answer.answer })) ?? null,
      answeredAt: iso(feature.answeredAt ?? null),
    });
  }
}

/**
 * Fleet flow F1: the flow as every flow route answers it. `url` is the web path F6 renders, built from
 * the project slug the route resolved, so a client needs no second lookup to link to the flow.
 */
export class FleetFlowDto {
  @ApiProperty() declare id: string;
  @ApiProperty() declare projectId: string;
  @ApiProperty() declare repoId: string;
  @ApiPropertyOptional({ type: String, nullable: true }) declare threadId: string | null;
  @ApiProperty({ enum: ['THREAD', 'NAX'] }) declare entry: FleetFlowEntry;
  @ApiProperty({ type: FleetFlowCreatorDto }) declare createdBy: FleetFlowCreatorDto;
  @ApiProperty() declare branch: string;
  @ApiProperty() declare specSha: string;
  @ApiPropertyOptional({ type: String, nullable: true }) declare pinnedRunnerId: string | null;
  @ApiProperty({ type: FleetFlowRolesDto }) declare roles: FleetFlowRolesDto;
  @ApiProperty({ type: String, description: 'Decimal as string' }) declare costCapUsd: string;
  @ApiProperty({ type: String, description: 'Decimal as string' }) declare spentUsd: string;
  @ApiProperty({ enum: ['PENDING', 'APPROVED', 'RUNNING', 'WAITING_MERGE', 'WAITING_ANSWER', 'COMPLETED', 'STOPPED'] })
  declare state: string;
  @ApiPropertyOptional({ type: FleetFlowApprovalDto, nullable: true }) declare approval: FleetFlowApprovalDto | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare stopReason: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare stopDetail: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare endedAt: string | null;
  @ApiProperty() declare createdAt: string;
  @ApiProperty({ type: [FleetFlowFeatureDto] }) declare features: FleetFlowFeatureDto[];
  @ApiProperty({ description: 'Web path of the flow page' }) declare url: string;

  static from(record: FleetFlowRecord, projectSlug: string): FleetFlowDto {
    const features = [...record.features].sort((a, b) => a.position - b.position);
    return Object.assign(new FleetFlowDto(), {
      id: record.id,
      projectId: record.projectId,
      repoId: record.repoId,
      threadId: record.threadId,
      entry: record.entry,
      createdBy: { type: record.createdByType, id: record.createdById },
      branch: record.branch,
      specSha: record.specSha,
      pinnedRunnerId: record.pinnedRunnerId,
      roles: { reviewer: record.reviewerRole, supervisor: record.supervisorRole },
      costCapUsd: record.costCapUsd,
      spentUsd: record.spentUsd,
      state: record.state,
      approval: approvalOf(record),
      stopReason: record.stopReason,
      stopDetail: record.stopDetail ?? null,
      endedAt: iso(record.endedAt),
      createdAt: record.createdAt.toISOString(),
      features: features.map((feature) => FleetFlowFeatureDto.from(feature)),
      url: `/${projectSlug}/flows/${record.id}`,
    });
  }
}

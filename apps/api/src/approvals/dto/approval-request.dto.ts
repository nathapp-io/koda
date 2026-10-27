import { ApiProperty } from '@nestjs/swagger';
import type { ApprovalRequestDetail } from '../approval-request.queries';
import type { ApprovalDecisionRecord, ApprovalRequestRecord } from '../domain/approval.domain';
import { APPROVAL_REQUEST_STATUSES } from './list-approval-requests.query';

class ApprovalRequestFields {
  @ApiProperty() id!: string;
  @ApiProperty() permissionKey!: string;
  @ApiProperty({ type: String, nullable: true }) projectId!: string | null;
  @ApiProperty({ enum: ['USER', 'AGENT', 'SYSTEM'] }) actorType!: string;
  @ApiProperty() actorId!: string;
  @ApiProperty({ type: String, enum: ['USER', 'AGENT'], nullable: true }) onBehalfOfType!: string | null;
  @ApiProperty({ type: String, nullable: true }) onBehalfOfId!: string | null;
  @ApiProperty() origin!: string;
  @ApiProperty({ enum: ['none', 'self', 'agent', 'human'] }) requiredMode!: string;
  @ApiProperty({ enum: APPROVAL_REQUEST_STATUSES }) status!: string;
  @ApiProperty({ type: String, enum: ['none', 'self', 'agent', 'human'], nullable: true }) satisfiedBy!: string | null;
  @ApiProperty({ type: String, enum: ['USER', 'AGENT'], nullable: true }) approverType!: string | null;
  @ApiProperty({ type: String, nullable: true }) approverId!: string | null;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) decidedAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) settledAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class ApprovalRequestSummaryDto extends ApprovalRequestFields {
  static from(record: ApprovalRequestRecord): ApprovalRequestSummaryDto {
    return Object.assign(new ApprovalRequestSummaryDto(), {
      id: record.id, permissionKey: record.permissionKey, projectId: record.projectId,
      actorType: record.actor.type, actorId: record.actor.id,
      onBehalfOfType: record.onBehalfOf?.type ?? null, onBehalfOfId: record.onBehalfOf?.id ?? null,
      origin: record.origin, requiredMode: record.requiredMode, status: record.status,
      satisfiedBy: record.satisfiedBy, approverType: record.approverType, approverId: record.approverId,
      expiresAt: record.expiresAt.toISOString(), decidedAt: record.decidedAt?.toISOString() ?? null,
      settledAt: record.settledAt?.toISOString() ?? null, createdAt: record.createdAt.toISOString(),
    });
  }
}

export class ApprovalDecisionDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['USER', 'AGENT'] }) deciderType!: string;
  @ApiProperty() deciderId!: string;
  @ApiProperty({ enum: ['approve', 'reject'] }) decision!: string;
  @ApiProperty({ type: String, nullable: true }) comment!: string | null;
  @ApiProperty({ type: Object, nullable: true }) params!: unknown;
  @ApiProperty({ format: 'date-time' }) decidedAt!: string;

  static from(record: ApprovalDecisionRecord): ApprovalDecisionDto {
    return Object.assign(new ApprovalDecisionDto(), {
      id: record.id, deciderType: record.deciderType, deciderId: record.deciderId,
      decision: record.decision, comment: record.comment, params: record.params, decidedAt: record.decidedAt.toISOString(),
    });
  }
}

export class ApprovalRequestDto extends ApprovalRequestFields {
  @ApiProperty({ type: Object, nullable: true }) input!: unknown;
  @ApiProperty({ type: Object, nullable: true }) result!: unknown;
  @ApiProperty({ type: [ApprovalDecisionDto] }) decisions!: ApprovalDecisionDto[];

  static from(detail: ApprovalRequestDetail): ApprovalRequestDto {
    return Object.assign(new ApprovalRequestDto(), ApprovalRequestSummaryDto.from(detail.request), {
      input: detail.request.input, result: detail.request.result,
      decisions: detail.decisions.map(ApprovalDecisionDto.from),
    });
  }
}

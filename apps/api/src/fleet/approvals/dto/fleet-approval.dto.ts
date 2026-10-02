import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  APPROVAL_DECISIONS, APPROVAL_RESOLVED_BY, APPROVAL_STATUSES, APPROVAL_TYPES, ApprovalDecision, ApprovalResolvedBy, ApprovalStatus,
  ApprovalType, FleetApprovalRecord, RequeueCandidate,
} from '../domain/approval.domain';

export class RequeueCandidateDto {
  @ApiProperty() declare jobId: string;
  @ApiProperty() declare projectId: string;
  @ApiProperty() declare feature: string;
  @ApiProperty() declare queuedAt: string;

  static from(c: RequeueCandidate): RequeueCandidateDto {
    return Object.assign(new RequeueCandidateDto(), { jobId: c.jobId, projectId: c.projectId, feature: c.feature, queuedAt: c.queuedAt.toISOString() });
  }
}

/** S1.5 §1.1 approval row; `payload` and `outcome` are per-type objects (plan D237). */
export class FleetApprovalDto {
  @ApiProperty() declare id: string;
  @ApiProperty({ enum: APPROVAL_TYPES }) declare type: ApprovalType;
  @ApiProperty({ enum: APPROVAL_STATUSES }) declare status: ApprovalStatus;
  @ApiPropertyOptional({ type: String, nullable: true }) declare projectId: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare jobId: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare policyId: string | null;
  @ApiProperty({ type: 'object', additionalProperties: true }) declare payload: Record<string, unknown>;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true, nullable: true }) declare outcome: Record<string, unknown> | null;
  @ApiProperty() declare requestedAt: string;
  @ApiPropertyOptional({ type: String, nullable: true }) declare expiresAt: string | null;
  @ApiPropertyOptional({ enum: APPROVAL_DECISIONS, nullable: true }) declare decision: ApprovalDecision | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare decidedById: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare decidedAt: string | null;
  @ApiPropertyOptional({ enum: APPROVAL_RESOLVED_BY, nullable: true }) declare resolvedBy: ApprovalResolvedBy | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare comment: string | null;
  @ApiPropertyOptional({ type: [RequeueCandidateDto], description: 'Pending budget approvals on get only (spec §1.5)' })
  requeueCandidates?: RequeueCandidateDto[];
  @ApiPropertyOptional({ description: 'More than 200 candidates exist' }) requeueCandidatesTruncated?: boolean;

  static from(a: FleetApprovalRecord, candidates?: { rows: RequeueCandidate[]; truncated: boolean }): FleetApprovalDto {
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    return Object.assign(new FleetApprovalDto(), {
      id: a.id, type: a.type, status: a.status, projectId: a.projectId, jobId: a.jobId, policyId: a.policyId, payload: a.payload,
      outcome: a.outcome, requestedAt: a.requestedAt.toISOString(), expiresAt: iso(a.expiresAt), decision: a.decision,
      decidedById: a.decidedById, decidedAt: iso(a.decidedAt), resolvedBy: a.resolvedBy, comment: a.comment,
      ...(candidates ? { requeueCandidates: candidates.rows.map(RequeueCandidateDto.from), requeueCandidatesTruncated: candidates.truncated } : {}),
    });
  }
}

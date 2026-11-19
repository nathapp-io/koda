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
  @ApiProperty() redeem!: boolean;
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
      origin: record.origin, redeem: record.redeem === true, requiredMode: record.requiredMode, status: record.status,
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
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true }) details!: Record<string, unknown> | null;
  @ApiProperty({ type: Object, nullable: true }) input!: unknown;
  /**
   * Review-1119 US-006 (B2): the executed command's recorded answer, `null` until it executes. The shape
   * belongs to the command, so it cannot be one schema — but the approved full import is the operation
   * whose answer a client needs to read, and it is not reachable through any sync response (that one has
   * already answered `202 pending`): this field is where its fetch result is reported.
   *
   * Review-1119 (D-5): that answer is the fetch's, not a finished import's, and a request that failed
   * records an error instead. `vcs.sync.all` always records `tickets: []` — the import runs after this
   * commit — so the description must not read as if it listed the tickets the import created.
   */
  @ApiProperty({
    type: Object,
    nullable: true,
    description: 'The executed command\'s recorded result, null until the request executes; the shape is the '
      + 'command\'s own. An executed `vcs.sync.all` records the approved full import\'s fetch metadata, not a '
      + 'completed import: `syncType` `manual`, `issuesSynced` 0, `issuesSkipped` 0 and `tickets` always `[]` '
      + '(the import itself runs after this commit), plus `fetchedIssues` (issues the import will process, '
      + 'after the allowedAuthors filter) and `capped` (the provider had more issues than the fetch '
      + 'returned). A request that failed records `{ error }` instead — the pre-check code, or '
      + '`execution-failed` with the thrown error\'s `name`.',
    example: {
      syncType: 'manual',
      issuesSynced: 0,
      issuesSkipped: 0,
      tickets: [],
      fetchedIssues: 3,
      capped: true,
    },
  })
  result!: unknown;
  @ApiProperty({ type: [ApprovalDecisionDto] }) decisions!: ApprovalDecisionDto[];

  static from(detail: ApprovalRequestDetail): ApprovalRequestDto {
    return Object.assign(new ApprovalRequestDto(), ApprovalRequestSummaryDto.from(detail.request), {
      input: detail.request.input, result: detail.request.result, details: detail.details ?? null,
      decisions: detail.decisions.map(ApprovalDecisionDto.from),
    });
  }
}

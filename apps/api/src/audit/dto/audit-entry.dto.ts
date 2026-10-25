import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EMPTY_AUDIT_DISPLAY, type AuditDisplay, type AuditEntryRecord } from '../domain/audit-entry.domain';

export class AuditEntryDto {
  @ApiProperty() declare id: string;
  @ApiProperty() declare key: string;
  @ApiProperty() declare resourceType: string;
  @ApiProperty() declare resourceId: string;
  @ApiPropertyOptional({ nullable: true, type: String }) declare projectId: string | null;
  @ApiProperty({ type: Object }) declare actor: { type: 'USER' | 'AGENT' | 'RUNNER' | 'SYSTEM'; id: string };
  @ApiPropertyOptional({ nullable: true, type: Object }) declare onBehalfOf: { type: 'USER' | 'AGENT'; id: string } | null;
  @ApiProperty({ enum: ['rest', 'mcp', 'thread', 'runner', 'system'] }) declare origin: 'rest' | 'mcp' | 'thread' | 'runner' | 'system';
  @ApiProperty({ type: Object }) declare approval: {
    requiredMode: string;
    satisfiedBy: string;
    approverType: 'USER' | 'AGENT' | null;
    approverId: string | null;
    requestId: string | null;
  };
  @ApiProperty() declare correlationId: string;
  @ApiPropertyOptional({ nullable: true, type: String }) declare summary: string | null;
  @ApiProperty({ type: Object }) declare display: AuditDisplay;
  @ApiProperty() declare createdAt: string;

  static from(r: AuditEntryRecord, display: AuditDisplay = EMPTY_AUDIT_DISPLAY): AuditEntryDto {
    return Object.assign(new AuditEntryDto(), {
      id: r.id,
      key: r.key,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      projectId: r.projectId,
      actor: { type: r.actorType, id: r.actorId },
      onBehalfOf: r.onBehalfOfType === null || r.onBehalfOfId === null ? null : { type: r.onBehalfOfType, id: r.onBehalfOfId },
      origin: r.origin,
      approval: {
        requiredMode: r.requiredMode,
        satisfiedBy: r.satisfiedBy,
        approverType: r.approverType,
        approverId: r.approverId,
        requestId: r.approvalRequestId,
      },
      correlationId: r.correlationId,
      summary: r.summary,
      display,
      createdAt: r.createdAt.toISOString(),
    });
  }
}

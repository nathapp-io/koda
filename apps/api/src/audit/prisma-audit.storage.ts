import { Inject, Injectable } from '@nestjs/common';
import type { AuditEntry as PackageAuditEntry, IAuditStorage } from '@nathapp/nestjs-audit';
import { AUDIT_ENTRY_REPOSITORY, type AuditEntryRecord, type KodaAuditMetadata } from './domain/audit-entry.domain';
import type { PrismaAuditEntryRepository } from './prisma-audit-entry.repository';

@Injectable()
export class PrismaAuditStorage implements IAuditStorage {
  constructor(@Inject(AUDIT_ENTRY_REPOSITORY) private readonly repository: PrismaAuditEntryRepository) {}

  async record(entry: PackageAuditEntry): Promise<void> {
    if (!entry.actor) this.invalid('actor');
    if (!entry.actor.type) this.invalid('actor.type');
    if (!entry.resource) this.invalid('resource');
    if (!entry.resourceId) this.invalid('resourceId');
    if (!entry.correlationId) this.invalid('correlationId');
    if (!entry.metadata) this.invalid('metadata');
    const metadata = entry.metadata as unknown as Partial<KodaAuditMetadata>;
    if (!metadata.origin) this.invalid('metadata.origin');
    if (!metadata.approval) this.invalid('metadata.approval');
    const approval = metadata.approval;
    const record: AuditEntryRecord = {
      key: entry.action,
      resourceType: entry.resource,
      resourceId: entry.resourceId,
      actorType: entry.actor.type as AuditEntryRecord['actorType'],
      actorId: entry.actor.id,
      correlationId: entry.correlationId,
      createdAt: entry.timestamp,
      projectId: metadata.projectId ?? null,
      onBehalfOfType: metadata.onBehalfOf?.type ?? null,
      onBehalfOfId: metadata.onBehalfOf?.id ?? null,
      origin: metadata.origin,
      requiredMode: approval.requiredMode,
      satisfiedBy: approval.satisfiedBy,
      approverType: approval.approverType ?? null,
      approverId: approval.approverId ?? null,
      approvalRequestId: approval.requestId ?? null,
      summary: metadata.summary ?? null,
    };
    if (metadata.recordId) await this.repository.createOnce({ ...record, id: metadata.recordId });
    else await this.repository.create(record);
  }

  private invalid(field: string): never {
    throw new Error(`audit entry is not a koda audit entry: ${field}`);
  }
}

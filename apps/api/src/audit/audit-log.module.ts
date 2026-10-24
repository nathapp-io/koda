import { Module } from '@nestjs/common';
import { AUDIT_STORAGE } from '@nathapp/nestjs-audit';
import { AUDIT_ENTRY_REPOSITORY } from './domain/audit-entry.domain';
import { PrismaAuditEntryRepository } from './prisma-audit-entry.repository';
import { PrismaAuditStorage } from './prisma-audit.storage';
import { AuditRecorder } from './audit-recorder.service';
import { AuditLogService } from './audit-log.service';

@Module({
  providers: [
    PrismaAuditEntryRepository,
    { provide: AUDIT_ENTRY_REPOSITORY, useExisting: PrismaAuditEntryRepository },
    PrismaAuditStorage,
    { provide: AUDIT_STORAGE, useExisting: PrismaAuditStorage },
    AuditRecorder,
    AuditLogService,
  ],
  exports: [AuditRecorder, AuditLogService],
})
export class AuditLogModule {}

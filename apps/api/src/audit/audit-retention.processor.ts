import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { runAsSystemWriter } from '../action-context/action-context';
import { IRetentionConfig, RETENTION_CFG } from '../config/retention.config';
import { SystemWriter } from '../permissions/system-writer.decorator';
import { AuditRecorder } from './audit-recorder.service';
import { PrismaAuditEntryRepository } from './prisma-audit-entry.repository';

/**
 * US-002: nightly purge of audit entries older than AUDIT_RETENTION_DAYS. The log grows with every
 * audited write and nothing else ever deletes from it. 05:00 is the webhook delivery purge; this runs
 * at 05:30. A failed purge is logged and swallowed — the next night's run is the retry.
 */
@Injectable()
@SystemWriter('system.audit.retention')
export class AuditRetentionProcessor {
  private readonly logger = new Logger(AuditRetentionProcessor.name);
  private static readonly DAY_MS = 86_400_000;

  constructor(
    private readonly repository: PrismaAuditEntryRepository,
    private readonly config: ConfigService,
    private readonly audit: AuditRecorder,
  ) {}

  /** The cron method is the background entry; the purge runs as `audit`. */
  @Cron('30 5 * * *')
  scheduledPurge(): Promise<void> {
    return runAsSystemWriter(this, () => this.purgeEntries());
  }

  private async purgeEntries(): Promise<void> {
    const days = this.config.get<IRetentionConfig>(RETENTION_CFG)?.auditDays;
    if (days === null || days === undefined || days <= 0) {
      return;
    }
    const before = new Date(Date.now() - days * AuditRetentionProcessor.DAY_MS);
    try {
      // The delete and its entry commit together: a rejected record rolls the delete back, so the
      // entries stay for the next night and the catch below logs it.
      const deleted = await this.audit.audited(
        () => this.repository.deleteCreatedBefore(before),
        (count) => count === 0 ? [] : [{
          key: 'system.audit.retention',
          resourceType: 'audit-entry',
          resourceId: 'all',
          projectId: null,
          summary: `purged ${count} audit entries`,
        }],
      );
      this.logger.log(`Purged ${deleted} audit entr${deleted === 1 ? 'y' : 'ies'} created before ${before.toISOString()}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Audit retention purge failed, will retry next run: ${message}`, stack);
    }
  }
}

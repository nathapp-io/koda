import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { runAsSystemWriter } from '../action-context/action-context';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { IRetentionConfig, RETENTION_CFG } from '../config/retention.config';
import { SystemWriter } from '../permissions/system-writer.decorator';
import { PrismaApprovalRequestRepository } from './prisma-approval-request.repository';

/**
 * US-003: nightly purge of settled approval requests older than APPROVAL_RETENTION_DAYS. Nothing ever
 * deletes a decided request, so the table keeps every decision, fleet ask and assistant action it
 * ever held. 05:00 is the webhook delivery purge and 05:30 the audit log purge; this runs at 05:15.
 *
 * Only settled requests go: `pending` and `approved` rows can still be decided or executed, however
 * long ago they were last written. The decisions, the fleet ask and the assistant action follow their
 * request through `onDelete: Cascade`.
 *
 * A failed purge is logged and swallowed — the next night's run is the retry, and a throwing cron
 * buys nothing. The delete and its audit entry commit together, so a rejected record keeps the rows.
 */
@Injectable()
@SystemWriter('system.approval.retention')
export class ApprovalRetentionProcessor {
  private readonly logger = new Logger(ApprovalRetentionProcessor.name);
  private static readonly DAY_MS = 86_400_000;

  constructor(
    private readonly repository: PrismaApprovalRequestRepository,
    private readonly config: ConfigService,
    private readonly audit: AuditRecorder,
  ) {}

  /** The cron method is the background entry; the purge runs as `approval`. */
  @Cron('15 5 * * *')
  scheduledPurge(): Promise<void> {
    return runAsSystemWriter(this, () => this.purgeSettledRequests());
  }

  private async purgeSettledRequests(): Promise<void> {
    const days = this.config.get<IRetentionConfig>(RETENTION_CFG)?.approvalDays;
    if (days === null || days === undefined || days <= 0) {
      return;
    }
    const before = new Date(Date.now() - days * ApprovalRetentionProcessor.DAY_MS);
    try {
      // The delete and its entry commit together: a rejected record rolls the delete back, so the
      // requests stay for the next night and the catch below logs it.
      const deleted = await this.audit.audited(
        () => this.repository.deleteSettledBefore(before),
        (count) => count === 0 ? [] : [{
          key: 'system.approval.retention',
          resourceType: 'approval-request',
          resourceId: 'all',
          projectId: null,
          summary: `purged ${count} settled approval requests`,
        }],
      );
      this.logger.log(`Purged ${deleted} settled approval request(s) not updated since ${before.toISOString()}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Approval retention purge failed, will retry next run: ${message}`, stack);
    }
  }
}

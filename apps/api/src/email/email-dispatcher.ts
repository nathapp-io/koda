import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  INotifyService, NOTIFY_SERVICE, NotifyException, NotifyExceptionCode, PermanentNotificationError,
} from '@nathapp/nestjs-notify';
import { EmailAvailability } from './email-availability';
import { EmailContentBuilder } from './email-content.builder';
import { KODA_TENANT_ID } from './koda-tenant';
import { EmailScheduleService } from './schedule/email-schedule.service';
import { EmailScheduleRow } from './schedule/email-schedule.types';

export type SendOutcome = 'SENT' | 'FAILED' | 'RETRY';

/** Rows claimed per tick. Small enough that a stuck send delays the batch by seconds, not minutes. */
const CLAIM_LIMIT = 50;

/** Codes that mean retrying can never succeed (spec §2.2). */
const PERMANENT_NOTIFY_CODES = new Set<unknown>([
  NotifyExceptionCode.TEMPLATE_NOT_FOUND, 'TEMPLATE_NOT_FOUND',
  NotifyExceptionCode.CHANNEL_NOT_REGISTERED, 'CHANNEL_NOT_REGISTERED',
  NotifyExceptionCode.TENANT_MISMATCH, 'TENANT_MISMATCH',
]);

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Fleet S4b US-002 (D518/D519): the delayed email dispatcher. `tick` closes abandoned invite sends,
 * claims due rows and hands each to `sendOne`; one row's failure never stops the batch.
 */
@Injectable()
export class EmailDispatcher {
  private readonly logger = new Logger(EmailDispatcher.name);

  constructor(
    private readonly schedule: EmailScheduleService,
    private readonly builder: EmailContentBuilder,
    @Inject(NOTIFY_SERVICE) private readonly notify: INotifyService,
    private readonly email: EmailAvailability,
  ) {}

  async tick(now: Date): Promise<void> {
    await this.schedule.closeAbandonedInvites(now);
    const rows = await this.schedule.claimDue(now, CLAIM_LIMIT);
    for (const row of rows) {
      try {
        const content = await this.builder.build(row);
        if ('skip' in content) {
          await this.schedule.markSkipped(row.id, content.skip);
          continue;
        }
        await this.sendOne(row, row.kind, content.data, content.userId, now);
      } catch (error) {
        // A builder or repository failure for one owned row backs it off; the rest of the batch continues.
        await this.schedule.retryAt(row.id, this.backoffDue(row.attempts, now), messageOf(error));
      }
    }
  }

  async sendOne(
    row: EmailScheduleRow,
    templateCode: string,
    data: Record<string, unknown>,
    userId: string | null,
    now: Date,
    retryable = true,
  ): Promise<SendOutcome> {
    try {
      await this.notify.send({
        tenantId: KODA_TENANT_ID,
        channel: 'email',
        templateCode,
        locale: row.locale,
        recipient: row.toEmail,
        userId: userId ?? undefined,
        data,
      });
      await this.schedule.markSent(row.id, now);
      return 'SENT';
    } catch (error) {
      const message = messageOf(error);
      const exhausted = row.attempts >= this.email.config().maxAttempts;
      if (!retryable || exhausted || this.isPermanent(error)) {
        await this.schedule.markFailed(row.id, message);
        this.logger.warn(`email ${row.id} (${row.kind}) failed after ${row.attempts} attempt(s)`);
        return 'FAILED';
      }
      await this.schedule.retryAt(row.id, this.backoffDue(row.attempts, now), message);
      return 'RETRY';
    }
  }

  /** Exponential backoff of `2^(attempts-1)` minutes; the first retry waits two minutes (spec §2.2). */
  private backoffDue(attempts: number, now: Date): Date {
    const minutes = 2 ** Math.max(1, attempts - 1);
    return new Date(now.getTime() + minutes * 60_000);
  }

  private isPermanent(error: unknown): boolean {
    if (error instanceof PermanentNotificationError) return true;
    return error instanceof NotifyException && PERMANENT_NOTIFY_CODES.has(error.code);
  }
}

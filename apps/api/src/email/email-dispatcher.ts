import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  INotifyService, NOTIFY_SERVICE, NotifyException, NotifyExceptionCode, PermanentNotificationError,
} from '@nathapp/nestjs-notify';
import { EmailAvailability } from './email-availability';
import { EmailContentBuilder } from './email-content.builder';
import { KODA_TENANT_ID } from './koda-tenant';
import { EmailScheduleService } from './schedule/email-schedule.service';
import { EmailScheduleRow } from './schedule/email-schedule.types';

export type SendOutcome = 'SENT' | 'FAILED' | 'RETRY';

/** Rows claimed per tick (spec §2.2: batch 20). Small enough that a stuck send delays the batch by seconds, not minutes. */
const CLAIM_LIMIT = 20;

/** D518: the in-process dispatcher fires about every 30 seconds (single API instance). */
const TICK_INTERVAL_MS = 30_000;

/** Codes that mean retrying can never succeed (spec §2.2). */
const PERMANENT_NOTIFY_CODES = new Set<unknown>([
  NotifyExceptionCode.TEMPLATE_NOT_FOUND, 'TEMPLATE_NOT_FOUND',
  NotifyExceptionCode.CHANNEL_NOT_REGISTERED, 'CHANNEL_NOT_REGISTERED',
  NotifyExceptionCode.TENANT_MISMATCH, 'TENANT_MISMATCH',
]);

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Fleet S4b US-002 (D518/D519): the delayed email dispatcher. `tick` closes abandoned invite sends,
 * claims due rows and hands each to `sendOne`; one row's failure never stops the batch. A scheduled
 * tick runs about every 30 seconds and never overlaps a still-running scheduled tick.
 */
@Injectable()
export class EmailDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmailDispatcher.name);
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly schedule: EmailScheduleService,
    private readonly builder: EmailContentBuilder,
    @Inject(NOTIFY_SERVICE) private readonly notify: INotifyService,
    private readonly email: EmailAvailability,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.runScheduledTick();
    }, TICK_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * The scheduled entry point: a tick that is still in flight suppresses the next interval, so two
   * scheduled ticks never overlap. A failure of the tick itself (claim/close) is logged, not thrown.
   */
  async runScheduledTick(now = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tick(now);
    } catch (error) {
      this.logger.error(`Email dispatch tick failed: ${messageOf(error)}`);
    } finally {
      this.ticking = false;
    }
  }

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
        // retryAt itself can throw (DB blip) — log it so a transient scheduling failure does not drop the rest of the batch.
        try {
          await this.schedule.retryAt(row.id, this.backoffDue(row.attempts, now), messageOf(error));
        } catch (retryError) {
          this.logger.error(
            `email ${row.id} (${row.kind}) could not be backed off after a build/send failure: ${messageOf(retryError)}`,
          );
        }
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

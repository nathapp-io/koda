import { Inject, Injectable, Logger } from '@nestjs/common';
import { INotifyService, NOTIFY_SERVICE } from '@nathapp/nestjs-notify';
import { EmailAvailability } from './email-availability';
import { EmailContentBuilder } from './email-content.builder';
import { EmailScheduleService } from './schedule/email-schedule.service';
import { EmailScheduleRow } from './schedule/email-schedule.types';

export type SendOutcome = 'SENT' | 'FAILED' | 'RETRY';

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

  /** US-002 stub: the implementer owns claiming, building and the per-row send/retry loop. */
  async tick(_now: Date): Promise<void> {
    throw new Error('EmailDispatcher.tick is not implemented');
  }

  /** US-002 stub: the implementer owns send, retry backoff and terminal-failure classification. */
  async sendOne(
    _row: EmailScheduleRow,
    _templateCode: string,
    _data: Record<string, unknown>,
    _userId: string | null,
    _now: Date,
    _retryable?: boolean,
  ): Promise<SendOutcome> {
    throw new Error('EmailDispatcher.sendOne is not implemented');
  }
}

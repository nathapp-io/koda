import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { OutboxStatus } from '@nathapp/nestjs-outbox';
import { PrismaOutboxRepository } from './prisma-outbox.repository';
import { IOutboxConfig, OUTBOX_CFG } from '../config/outbox.config';

/**
 * Nightly retention purge for terminal outbox rows (issue #135). Published and
 * dead rows are delivery plumbing, not source of truth, so after
 * OUTBOX_RETENTION_DAYS they are deleted to keep the table bounded. 03:00 is
 * taken by memory governance; this runs at 04:00. A failed purge is logged and
 * swallowed — the next night's run is the retry, and a throwing cron buys
 * nothing (memory governance aggregates because it loops per project; this is
 * a single statement).
 */
@Injectable()
export class OutboxRetentionProcessor {
  private readonly logger = new Logger(OutboxRetentionProcessor.name);
  private static readonly DAY_MS = 86_400_000;

  constructor(
    private readonly repository: PrismaOutboxRepository,
    private readonly config: ConfigService,
  ) {}

  @Cron('0 4 * * *')
  async scheduledPurge(): Promise<void> {
    const outbox = this.config.get<IOutboxConfig>(OUTBOX_CFG);
    const days = outbox?.retention.days;
    if (days === null || days === undefined || days <= 0) {
      return;
    }
    const before = new Date(Date.now() - days * OutboxRetentionProcessor.DAY_MS);
    try {
      const deleted = await this.repository.deleteTerminalBefore([OutboxStatus.PUBLISHED, OutboxStatus.DEAD], before);
      this.logger.log(`Purged ${deleted} terminal outbox event(s) not updated since ${before.toISOString()}`);
    } catch (error) {
      this.logger.error(`Outbox retention purge failed, will retry next run: ${(error as Error).message}`);
    }
  }
}

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OutboxService } from './outbox.service';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class OutboxProcessor implements OnModuleInit {
  private readonly logger = new Logger(OutboxProcessor.name);

  constructor(private readonly outboxService: OutboxService) {}

  onModuleInit() {
    this.logger.log('OutboxProcessor initialized');
  }

  @Cron(CronExpression.EVERY_10_SECONDS)
  async processOutboxQueue(): Promise<void> {
    await this.outboxService.processPending();
  }
}
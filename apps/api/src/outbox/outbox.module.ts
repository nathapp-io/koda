import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { OutboxService } from './outbox.service';
import { FanOutPublisher } from './fan-out-publisher';
import { OutboxProcessor } from './outbox-processor';
import { AdminController } from './admin.controller';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { PrismaOutboxRepository } from './prisma-outbox.repository';
import { OUTBOX_REPOSITORY } from './domain/outbox-event.domain';

@Module({
  // MemoryModule, EntityGraphModule, CodeIntelModule, and WebhookModule are
  // intentionally NOT imported here. Their outbox event handling is owned by
  // per-consumer outbox-subscriber providers registered in each of those modules
  // (see memory.module.ts, entity-graph.module.ts, code-intel.module.ts,
  // webhook-outbox.subscriber.ts), which import OutboxModule directly. Keeping
  // those consumer imports here as well would recreate an ESM temporal-dead-zone
  // cycle (OutboxModule -> consumer -> ... -> OutboxModule). FanOutPublisher
  // no longer takes any cross-module injections; the subscribers register the
  // equivalent handler behavior directly against it via onModuleInit().
  imports: [PrismaModule, ScheduleModule],
  controllers: [AdminController],
  providers: [
    PrismaOutboxRepository,
    { provide: OUTBOX_REPOSITORY, useExisting: PrismaOutboxRepository },
    OutboxService,
    FanOutPublisher,
    OutboxProcessor,
  ],
  exports: [OutboxService, FanOutPublisher],
})
export class OutboxModule {}

import { Module, forwardRef } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { OutboxService } from './outbox.service';
import { OutboxFanOutRegistry } from './outbox-fan-out-registry';
import { OutboxProcessor } from './outbox-processor';
import { AdminController } from './admin.controller';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { WebhookModule } from '../webhook/webhook.module';
import { PrismaOutboxRepository } from './prisma-outbox.repository';
import { OUTBOX_REPOSITORY } from './domain/outbox-event.domain';

@Module({
  // WebhookModule imports OutboxModule; reverse the edge with forwardRef so
  // OutboxFanOutRegistry can resolve WebhookDeliveryHandler via DI.
  //
  // MemoryModule, EntityGraphModule, and CodeIntelModule are intentionally NOT imported
  // here. Their outbox event handling is now owned by per-consumer outbox-subscriber
  // providers registered in each of those modules (see memory.module.ts,
  // entity-graph.module.ts, code-intel.module.ts), which import OutboxModule directly.
  // Keeping those consumer imports here as well would recreate an ESM temporal-dead-zone
  // cycle (OutboxModule -> consumer -> ... -> OutboxModule). OutboxFanOutRegistry's
  // @Optional() injections for the corresponding handlers simply resolve to undefined,
  // which is expected: the subscribers register the equivalent behavior instead.
  imports: [PrismaModule, ScheduleModule, forwardRef(() => WebhookModule)],
  controllers: [AdminController],
  providers: [
    PrismaOutboxRepository,
    { provide: OUTBOX_REPOSITORY, useExisting: PrismaOutboxRepository },
    OutboxService,
    OutboxFanOutRegistry,
    OutboxProcessor,
  ],
  exports: [OutboxService, OutboxFanOutRegistry],
})
export class OutboxModule {}

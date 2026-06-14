import { Module, forwardRef } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { OutboxService } from './outbox.service';
import { OutboxFanOutRegistry } from './outbox-fan-out-registry';
import { OutboxProcessor } from './outbox-processor';
import { AdminController } from './admin.controller';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { MemoryModule } from '../memory/memory.module';
import { EntityGraphModule } from '../entity-graph/entity-graph.module';
import { CodeIntelModule } from '../code-intel/code-intel.module';
import { PrismaOutboxRepository } from './prisma-outbox.repository';
import { OUTBOX_REPOSITORY } from './domain/outbox-event.domain';

@Module({
  // CodeIntelModule participates in a module cycle
  // (OutboxModule -> CodeIntelModule -> RagModule -> OutboxModule); use forwardRef so
  // the reference resolves lazily instead of landing in the ESM temporal dead zone.
  imports: [PrismaModule, ScheduleModule, MemoryModule, EntityGraphModule, forwardRef(() => CodeIntelModule)],
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

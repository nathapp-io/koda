import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectsModule } from '../projects/projects.module';
import { TimelineService } from './timeline.service';
import { PrismaTimelineRepository } from './prisma-timeline.repository';
import { TimelineController } from './timeline.controller';
import { PrismaMemoryItemRepository } from './prisma-memory-item.repository';
import { MEMORY_ITEM_REPOSITORY } from './domain/memory-item.domain';
import { MemoryGovernanceService } from './memory-governance.service';
import { MemoryGovernanceProcessor } from './memory-governance.processor';
import { ExtractionService } from './extraction.service';
import { MemoryController } from './memory.controller';
import { MemoryReadController } from './memory-read.controller';
import { CanonicalStateService } from './canonical-state.service';
import { PrismaCanonicalStateRepository } from './prisma-canonical-state.repository';
import { CANONICAL_STATE_REPOSITORY } from './domain/canonical-state.domain';
import { OutboxModule } from '../outbox/outbox.module';
import { MemoryOutboxSubscriber } from './memory-outbox.subscriber';

@Module({
  imports: [PrismaModule, forwardRef(() => ProjectsModule), OutboxModule],
  controllers: [TimelineController, MemoryController, MemoryReadController],
  providers: [
    PrismaTimelineRepository,
    TimelineService,
    PrismaCanonicalStateRepository,
    { provide: CANONICAL_STATE_REPOSITORY, useExisting: PrismaCanonicalStateRepository },
    CanonicalStateService,
    PrismaMemoryItemRepository,
    { provide: MEMORY_ITEM_REPOSITORY, useExisting: PrismaMemoryItemRepository },
    MemoryGovernanceService,
    MemoryGovernanceProcessor,
    ExtractionService,
    MemoryOutboxSubscriber,
  ],
  exports: [
    TimelineService,
    CanonicalStateService,
    PrismaMemoryItemRepository,
    { provide: MEMORY_ITEM_REPOSITORY, useExisting: PrismaMemoryItemRepository },
    MemoryGovernanceService,
    ExtractionService,
  ],
})
export class MemoryModule {}

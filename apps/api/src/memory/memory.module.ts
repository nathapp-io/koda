import { Module, forwardRef } from '@nestjs/common';
import { ReviewDecisionWriter } from './review-decision.writer';
import { ApprovalEngineModule } from '../approvals/approval-engine.module';
import { AuthRepositoryModule } from '../auth/auth-repository.module';
import { MemoryRouteCommands } from './memory-route.commands';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectsModule } from '../projects/projects.module';
import { ProjectAccessModule } from '../projects/project-access.module';
import { TimelineService } from './timeline.service';
import { PrismaTimelineRepository } from './prisma-timeline.repository';
import { TimelineController } from './timeline.controller';
import { PrismaMemoryItemRepository } from './prisma-memory-item.repository';
import { MEMORY_ITEM_REPOSITORY } from './domain/memory-item.domain';
import { MemoryGovernanceService } from './memory-governance.service';
import { MemoryGovernanceProcessor } from './memory-governance.processor';
import { ExtractionService } from './extraction.service';
import { MemoryController } from './memory.controller';
import { MemoryWriteGuard } from './memory-write.guard';
import { MemoryWriteService } from './memory-write.service';
import { MemoryReadController } from './memory-read.controller';
import { CanonicalStateService } from './canonical-state.service';
import { PrismaCanonicalStateRepository } from './prisma-canonical-state.repository';
import { CANONICAL_STATE_REPOSITORY } from './domain/canonical-state.domain';
import { OutboxModule } from '../outbox/outbox.module';
import { MemoryOutboxSubscriber } from './memory-outbox.subscriber';

@Module({
  // ProjectsModule stays forwardRef-imported for MemoryGovernanceProcessor, which uses
  // ProjectsService.findAllProjectIds — a method outside the ProjectAccessModule leaf.
  // TimelineController and MemoryReadController were repointed to ProjectAccessModule.
  // This edge closes the real cycle Memory -> Projects -> Agents -> Context -> Memory
  // (Projects -> Agents forwardRef in projects.module.ts, Context -> Memory forwardRef
  // in context.module.ts); attempts to make any single edge on this cycle plain while
  // keeping the others as forwardRef reproduce a circular-dependency failure, so this
  // forwardRef is left in place.
  imports: [ApprovalEngineModule, AuthRepositoryModule, PrismaModule, forwardRef(() => ProjectsModule), ProjectAccessModule, OutboxModule],
  controllers: [TimelineController, MemoryController, MemoryReadController],
  providers: [
    PrismaTimelineRepository,
    TimelineService,
    PrismaCanonicalStateRepository,
    { provide: CANONICAL_STATE_REPOSITORY, useExisting: PrismaCanonicalStateRepository },
    CanonicalStateService,
    PrismaMemoryItemRepository,
    { provide: MEMORY_ITEM_REPOSITORY, useExisting: PrismaMemoryItemRepository },
    // Permissions P1 US-008: the replace check every principal-driven write runs (the routes and both memory
    // tools). It reads the repository and the global PermissionService, so it adds no import edge.
    MemoryWriteGuard,
    MemoryWriteService,
    ReviewDecisionWriter,
    MemoryRouteCommands,
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
    MemoryWriteService,
    ReviewDecisionWriter,
    MemoryWriteGuard,
  ],
})
export class MemoryModule {}

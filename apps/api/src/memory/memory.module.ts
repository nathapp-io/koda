import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { TimelineService } from './timeline.service';
import { ContextBuilderService } from './context-builder.service';
import { TimelineController } from './timeline.controller';
import { MemoryItemRepository } from './memory-item-repository';
import { MemoryGovernanceService } from './memory-governance.service';
import { ExtractionService } from './extraction.service';
import { MemoryController } from './memory.controller';

@Module({
  imports: [PrismaModule],
  controllers: [TimelineController, MemoryController],
  providers: [TimelineService, ContextBuilderService, MemoryItemRepository, MemoryGovernanceService, ExtractionService],
  exports: [TimelineService, ContextBuilderService, MemoryItemRepository, MemoryGovernanceService, ExtractionService],
})
export class MemoryModule {}

import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { TimelineService } from './timeline.service';
import { ContextBuilderService } from './context-builder.service';
import { TimelineController } from './timeline.controller';
import { MemoryItemRepository } from './memory-item-repository';
import { MemoryGovernanceService } from './memory-governance.service';

@Module({
  imports: [PrismaModule],
  controllers: [TimelineController],
  providers: [TimelineService, ContextBuilderService, MemoryItemRepository, MemoryGovernanceService],
  exports: [TimelineService, ContextBuilderService, MemoryItemRepository, MemoryGovernanceService],
})
export class MemoryModule {}

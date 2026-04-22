import { Module } from '@nestjs/common';
import { TimelineService } from './timeline.service';
import { ContextBuilderService } from './context-builder.service';

@Module({
  providers: [TimelineService, ContextBuilderService],
  exports: [TimelineService, ContextBuilderService],
})
export class MemoryModule {}
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { TimelineService } from './timeline.service';
import { ContextBuilderService } from './context-builder.service';
import { TimelineController } from './timeline.controller';

@Module({
  imports: [PrismaModule],
  controllers: [TimelineController],
  providers: [TimelineService, ContextBuilderService],
  exports: [TimelineService, ContextBuilderService],
})
export class MemoryModule {}

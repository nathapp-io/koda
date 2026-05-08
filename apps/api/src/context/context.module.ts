import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ContextBuilderService } from './context-builder.service';
import { ContextController } from './context.controller';
import { MemoryModule } from '../memory/memory.module';
import { RagModule } from '../rag/rag.module';
import { EntityGraphModule } from '../entity-graph/entity-graph.module';
import { CodeIntelModule } from '../code-intel/code-intel.module';
import { MonitoringModule } from '../monitoring/monitoring.module';

@Module({
  imports: [PrismaModule, MemoryModule, RagModule, EntityGraphModule, CodeIntelModule, MonitoringModule],
  controllers: [ContextController],
  providers: [ContextBuilderService],
  exports: [ContextBuilderService],
})
export class ContextModule {}

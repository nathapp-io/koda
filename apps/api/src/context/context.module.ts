import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ContextBuilderService } from './context-builder.service';
import { ContextController } from './context.controller';
import { MemoryModule } from '../memory/memory.module';
import { RagModule } from '../rag/rag.module';
import { EntityGraphModule } from '../entity-graph/entity-graph.module';
import { CodeIntelModule } from '../code-intel/code-intel.module';
import { MonitoringModule } from '../monitoring/monitoring.module';
import { PrismaContextRepository } from './prisma-context.repository';
import { CONTEXT_REPOSITORY } from './domain/context.domain';
import { PrismaProjectRepository } from '../projects/prisma-project.repository';

@Module({
  imports: [PrismaModule, MemoryModule, forwardRef(() => RagModule), EntityGraphModule, forwardRef(() => CodeIntelModule), MonitoringModule],
  controllers: [ContextController],
  providers: [
    PrismaContextRepository,
    { provide: CONTEXT_REPOSITORY, useExisting: PrismaContextRepository },
    PrismaProjectRepository,
    ContextBuilderService,
  ],
  exports: [ContextBuilderService],
})
export class ContextModule {}

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
import { ProjectAccessModule } from '../projects/project-access.module';

@Module({
  imports: [PrismaModule, forwardRef(() => MemoryModule), forwardRef(() => RagModule), EntityGraphModule, forwardRef(() => CodeIntelModule), MonitoringModule, ProjectAccessModule],
  controllers: [ContextController],
  providers: [
    PrismaContextRepository,
    { provide: CONTEXT_REPOSITORY, useExisting: PrismaContextRepository },
    ContextBuilderService,
  ],
  exports: [ContextBuilderService],
})
export class ContextModule {}

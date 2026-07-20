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
  // MemoryModule stays forwardRef-imported: it sits on the real cycle
  // Memory -> Projects -> Agents -> Context -> Memory. See memory.module.ts
  // (ProjectsModule edge) and projects.module.ts (AgentsModule edge) for the
  // other two edges kept forwardRef to break this same cycle. Rag/CodeIntel
  // are not on this cycle and can stay plain.
  imports: [PrismaModule, forwardRef(() => MemoryModule), RagModule, EntityGraphModule, CodeIntelModule, MonitoringModule, ProjectAccessModule],
  controllers: [ContextController],
  providers: [
    PrismaContextRepository,
    { provide: CONTEXT_REPOSITORY, useExisting: PrismaContextRepository },
    ContextBuilderService,
  ],
  exports: [ContextBuilderService],
})
export class ContextModule {}

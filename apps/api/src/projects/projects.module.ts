import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { PrismaProjectRepository } from './prisma-project.repository';
import { PROJECT_REPOSITORY } from './domain/project.domain';
import { ProjectAccessModule } from './project-access.module';
import { RagModule } from '../rag/rag.module';
import { CodeIntelModule } from '../code-intel/code-intel.module';
import { AgentsModule } from '../agents/agents.module';

@Module({
  imports: [
    PrismaModule,
    ProjectAccessModule,
    RagModule,
    CodeIntelModule,
    // AgentsModule stays forwardRef-imported: it sits on the real cycle
    // Memory -> Projects -> Agents -> Context -> Memory. See memory.module.ts
    // for the ProjectsModule edge and context.module.ts for the MemoryModule edge.
    // Converting this single edge to plain (while the others on the cycle stayed
    // forwardRef) reproduces a circular-dependency e2e failure.
    forwardRef(() => AgentsModule),
  ],
  controllers: [ProjectsController],
  providers: [
    PrismaProjectRepository,
    { provide: PROJECT_REPOSITORY, useExisting: PrismaProjectRepository },
    ProjectsService,
  ],
  exports: [ProjectsService, ProjectAccessModule],
})
export class ProjectsModule {}

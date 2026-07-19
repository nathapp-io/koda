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
    forwardRef(() => RagModule),
    forwardRef(() => CodeIntelModule),
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

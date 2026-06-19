import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { PrismaProjectRepository } from './prisma-project.repository';
import { PROJECT_REPOSITORY } from './domain/project.domain';
import { RagModule } from '../rag/rag.module';
import { MemoryModule } from '../memory/memory.module';
import { CodeIntelModule } from '../code-intel/code-intel.module';
import { AgentsModule } from '../agents/agents.module';

@Module({
  imports: [PrismaModule, RagModule, MemoryModule, CodeIntelModule, AgentsModule],
  controllers: [ProjectsController],
  providers: [
    PrismaProjectRepository,
    { provide: PROJECT_REPOSITORY, useExisting: PrismaProjectRepository },
    ProjectsService,
  ],
  exports: [ProjectsService],
})
export class ProjectsModule {}

import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessService } from './project-access.service';
import { PrismaProjectRepository } from './prisma-project.repository';
import { PROJECT_REPOSITORY } from './domain/project.domain';

@Module({
  imports: [PrismaModule],
  providers: [
    ProjectAccessService,
    PrismaProjectRepository,
    { provide: PROJECT_REPOSITORY, useExisting: PrismaProjectRepository },
  ],
  exports: [
    ProjectAccessService,
    PrismaProjectRepository,
    { provide: PROJECT_REPOSITORY, useExisting: PrismaProjectRepository },
  ],
})
export class ProjectAccessModule {}

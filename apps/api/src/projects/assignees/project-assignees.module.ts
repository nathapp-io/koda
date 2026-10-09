import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessModule } from '../project-access.module';
import { PrismaProjectAssigneesRepository } from './prisma-project-assignees.repository';
import { ProjectAssigneesController } from './project-assignees.controller';
import { ProjectAssigneesService } from './project-assignees.service';
import { PROJECT_ASSIGNEES_REPOSITORY } from './domain/project-assignee.domain';

/**
 * S4c US-004: the assignee typeahead. Standalone (not part of
 * `ProjectMembersModule`): `ProjectAccessModule` supplies `ProjectMembershipGuard`,
 * the repository and its `PROJECT_ASSIGNEES_REPOSITORY` token stay module-private,
 * and only the service is the public face.
 */
@Module({
  imports: [PrismaModule, ProjectAccessModule],
  controllers: [ProjectAssigneesController],
  providers: [
    PrismaProjectAssigneesRepository,
    { provide: PROJECT_ASSIGNEES_REPOSITORY, useExisting: PrismaProjectAssigneesRepository },
    ProjectAssigneesService,
  ],
})
export class ProjectAssigneesModule {}

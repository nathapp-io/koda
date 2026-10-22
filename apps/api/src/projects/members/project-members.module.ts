import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessModule } from '../project-access.module';
import { ProjectMembersController } from './project-members.controller';
import { ProjectRolesController } from './project-roles.controller';
import { ProjectMembersService } from './project-members.service';
import { PrismaProjectMembersRepository } from './prisma-project-members.repository';

/** `ProjectRolesController` lives here (US-003): the project's roles are read behind the project gate. */
@Module({
  imports: [PrismaModule, ProjectAccessModule],
  controllers: [ProjectMembersController, ProjectRolesController],
  providers: [PrismaProjectMembersRepository, ProjectMembersService],
})
export class ProjectMembersModule {}

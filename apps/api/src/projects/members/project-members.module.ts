import { ApprovalEngineModule } from '../../approvals/approval-engine.module';
import { AuthRepositoryModule } from '../../auth/auth-repository.module';
import { MemberRouteCommands } from './member-route.commands';
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessModule } from '../project-access.module';
import { ProjectMembersController } from './project-members.controller';
import { ProjectRolesController } from './project-roles.controller';
import { ProjectMembersService } from './project-members.service';
import { PrismaProjectMembersRepository } from './prisma-project-members.repository';

/** `ProjectRolesController` lives here (US-003): the project's roles are read behind the project gate. */
@Module({
  imports: [ApprovalEngineModule, AuthRepositoryModule, PrismaModule, ProjectAccessModule],
  controllers: [ProjectMembersController, ProjectRolesController],
  providers: [MemberRouteCommands, PrismaProjectMembersRepository, ProjectMembersService],
})
export class ProjectMembersModule {}

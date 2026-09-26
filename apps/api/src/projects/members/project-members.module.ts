import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessModule } from '../project-access.module';
import { ProjectMembersController } from './project-members.controller';
import { ProjectMembersService } from './project-members.service';
import { PrismaProjectMembersRepository } from './prisma-project-members.repository';

@Module({
  imports: [PrismaModule, ProjectAccessModule],
  controllers: [ProjectMembersController],
  providers: [PrismaProjectMembersRepository, ProjectMembersService],
})
export class ProjectMembersModule {}

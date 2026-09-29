import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { VcsModule } from '../../vcs/vcs.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { GitBrokerModule } from '../git-broker/git-broker.module';
import { FleetReposController } from './fleet-repos.controller';
import { ProjectFleetReposController } from './project-fleet-repos.controller';
import { FleetReposService } from './fleet-repos.service';
import { PrismaFleetRepoRepository } from './prisma-fleet-repo.repository';
import { FLEET_REPO_REPOSITORY } from './domain/fleet-repo.domain';

@Module({
  imports: [PrismaModule, ProjectAccessModule, VcsModule, FleetActivityModule, GitBrokerModule],
  controllers: [FleetReposController, ProjectFleetReposController],
  providers: [PrismaFleetRepoRepository, { provide: FLEET_REPO_REPOSITORY, useExisting: PrismaFleetRepoRepository }, FleetReposService],
  exports: [FLEET_REPO_REPOSITORY],
})
export class FleetReposModule {}

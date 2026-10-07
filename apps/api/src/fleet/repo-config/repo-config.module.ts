import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { GitBrokerModule } from '../git-broker/git-broker.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { SyncModule } from '../sync/sync.module';
import { ConfigEditStoreModule } from './config-edit-store.module';
import { ConfigJobsService } from './config-jobs.service';
import { FLEET_REPO_FILES_READER } from './fleet-repo-files.reader';
import { FleetRepoFilesRouter } from './fleet-repo-files.router';
import { GithubFleetRepoFilesReader } from './github-fleet-repo-files.reader';
import { GitlabFleetRepoFilesReader } from './gitlab-fleet-repo-files.reader';
import { ProjectJobConfigEditController } from './project-job-config-edit.controller';
import { ProjectRepoConfigController } from './project-repo-config.controller';

/** Fleet S3 (spec docs/superpowers/specs/2026-10-07-fleet-s3-repo-config-and-credential-board-design.md). */
@Module({
  imports: [PrismaModule, ProjectAccessModule, FleetActivityModule, GitBrokerModule, FleetJobsModule, SyncModule, ConfigEditStoreModule],
  controllers: [ProjectRepoConfigController, ProjectJobConfigEditController],
  providers: [
    GithubFleetRepoFilesReader, GitlabFleetRepoFilesReader, FleetRepoFilesRouter,
    { provide: FLEET_REPO_FILES_READER, useExisting: FleetRepoFilesRouter },
    ConfigJobsService,
  ],
})
export class RepoConfigModule {}

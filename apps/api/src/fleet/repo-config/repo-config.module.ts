import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { GitBrokerModule } from '../git-broker/git-broker.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { SyncModule } from '../sync/sync.module';
import { ConfigEditStoreModule } from './config-edit-store.module';
import { ConfigJobsService } from './config-jobs.service';
import { FakeFleetRepoFilesReader } from './fake-fleet-repo-files.reader';
import { FLEET_REPO_FILES_READER, FleetRepoFilesReader } from './fleet-repo-files.reader';
import { FleetConfigTestHooksController } from './fleet-config-test-hooks.controller';
import { FleetRepoFilesRouter } from './fleet-repo-files.router';
import { GithubFleetRepoFilesReader } from './github-fleet-repo-files.reader';
import { GitlabFleetRepoFilesReader } from './gitlab-fleet-repo-files.reader';
import { ProjectJobConfigEditController } from './project-job-config-edit.controller';
import { ProjectRepoConfigController } from './project-repo-config.controller';
import { RunnerConfigEditController } from './runner-config-edit.controller';

/** S3 plan C11: the E2E fake only takes over when both test flags are on; production always gets the forge router. */
export function selectRepoFilesReader(
  cfg: Pick<IFleetConfig, 'testHooksEnabled' | 'testFakeNaxFiles'>,
  router: FleetRepoFilesReader,
  fake: FleetRepoFilesReader,
): FleetRepoFilesReader {
  return cfg.testHooksEnabled && cfg.testFakeNaxFiles ? fake : router;
}

/** Fleet S3 (spec docs/superpowers/specs/2026-10-07-fleet-s3-repo-config-and-credential-board-design.md). */
@Module({
  imports: [PrismaModule, ProjectAccessModule, FleetActivityModule, GitBrokerModule, FleetJobsModule, SyncModule, ConfigEditStoreModule],
  controllers: [ProjectRepoConfigController, ProjectJobConfigEditController, RunnerConfigEditController, FleetConfigTestHooksController],
  providers: [
    GithubFleetRepoFilesReader, GitlabFleetRepoFilesReader, FleetRepoFilesRouter, FakeFleetRepoFilesReader,
    {
      provide: FLEET_REPO_FILES_READER,
      inject: [FLEET_CFG, FleetRepoFilesRouter, FakeFleetRepoFilesReader],
      useFactory: selectRepoFilesReader,
    },
    ConfigJobsService,
  ],
})
export class RepoConfigModule {}

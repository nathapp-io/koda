import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { LiveModule } from '../../live/live.module';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { SkillsModule } from '../../skills/skills.module';
import { FleetReposModule } from '../repos/fleet-repos.module';
import { GitBrokerModule } from '../git-broker/git-broker.module';
import { ThreadStoreModule } from './thread-store.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { ThreadsController } from './threads.controller';
import { ThreadEventsController, ThreadEventsGuard } from './thread-events.controller';
import { ProjectBriefService } from './project-brief.service';
import { ThreadsService } from './threads.service';

@Module({
  // GitBrokerModule exports GitHubAppClient, which ProjectBriefService reads the repository context with (1c-D3).
  imports: [ProjectAccessModule, SkillsModule, FleetReposModule, ThreadStoreModule, FleetJobsModule, GitBrokerModule, AuthModule, LiveModule],
  controllers: [ThreadsController, ThreadEventsController],
  providers: [ThreadsService, ThreadEventsGuard, ProjectBriefService],
  exports: [ThreadsService],
})
export class ThreadsModule {}

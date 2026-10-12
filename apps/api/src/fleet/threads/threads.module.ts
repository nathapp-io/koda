import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { LiveModule } from '../../live/live.module';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { SkillsModule } from '../../skills/skills.module';
import { FleetReposModule } from '../repos/fleet-repos.module';
import { ThreadStoreModule } from './thread-store.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { ThreadsController } from './threads.controller';
import { ThreadsService } from './threads.service';

@Module({
  imports: [ProjectAccessModule, SkillsModule, FleetReposModule, ThreadStoreModule, FleetJobsModule, AuthModule, LiveModule],
  controllers: [ThreadsController],
  providers: [ThreadsService],
  exports: [ThreadsService],
})
export class ThreadsModule {}

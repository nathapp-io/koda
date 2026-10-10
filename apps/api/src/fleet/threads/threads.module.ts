import { Module } from '@nestjs/common';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { SkillsModule } from '../../skills/skills.module';
import { FleetReposModule } from '../repos/fleet-repos.module';
import { ThreadStoreModule } from './thread-store.module';
import { ThreadsController } from './threads.controller';
import { ThreadsService } from './threads.service';

@Module({
  imports: [ProjectAccessModule, SkillsModule, FleetReposModule, ThreadStoreModule],
  controllers: [ThreadsController],
  providers: [ThreadsService],
  exports: [ThreadsService],
})
export class ThreadsModule {}

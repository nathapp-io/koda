import { Module } from '@nestjs/common';
import { VcsController } from './vcs.controller';
import { VcsConnectionService } from './vcs-connection.service';
import { ProjectsService } from '../projects/projects.service';

@Module({
  controllers: [VcsController],
  providers: [VcsConnectionService, ProjectsService],
  exports: [VcsConnectionService],
})
export class VcsModule {}

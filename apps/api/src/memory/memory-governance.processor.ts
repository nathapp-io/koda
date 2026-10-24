import { SystemWriter } from '../permissions/system-writer.decorator';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { runAsSystemWriter } from '../action-context/action-context';
import { MemoryGovernanceService } from './memory-governance.service';
import { ProjectsService } from '../projects/projects.service';

@Injectable()
@SystemWriter('system.memory.govern')
export class MemoryGovernanceProcessor {
  private readonly logger = new Logger(MemoryGovernanceProcessor.name);

  constructor(
    private readonly governanceService: MemoryGovernanceService,
    private readonly projectsService: ProjectsService,
  ) {}

  /** Permissions P2 US-005: the cron method is the background entry; the cleanup runs as `memory`. */
  @Cron('0 3 * * *')
  async scheduledCleanup(): Promise<void> {
    await runAsSystemWriter(this, () => this.cleanUpAllProjects());
  }

  private async cleanUpAllProjects(): Promise<void> {
    this.logger.log('Starting scheduled memory governance cleanup');
    const projects = await this.projectsService.findAllProjectIds();
    const errors: Error[] = [];
    for (const project of projects) {
      try {
        await this.governanceService.runCleanup(project.id);
      } catch (error) {
        errors.push(error as Error);
        this.logger.error(`Failed cleanup for project ${project.id}: ${(error as Error).message}`);
      }
    }
    if (errors.length > 0) {
      throw new Error(`Governance cleanup failed for ${errors.length} project(s): ${errors.map(e => e.message).join('; ')}`);
    }
    this.logger.log('Completed scheduled memory governance cleanup');
  }
}
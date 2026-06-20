import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MemoryGovernanceService } from './memory-governance.service';
import { PrismaProjectRepository } from '../projects/prisma-project.repository';

@Injectable()
export class MemoryGovernanceProcessor {
  private readonly logger = new Logger(MemoryGovernanceProcessor.name);

  constructor(
    private readonly governanceService: MemoryGovernanceService,
    private readonly projectRepo: PrismaProjectRepository,
  ) {}

  @Cron('0 3 * * *')
  async scheduledCleanup(): Promise<void> {
    this.logger.log('Starting scheduled memory governance cleanup');
    const projects = await this.projectRepo.findAllIds();
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
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { MemoryGovernanceService } from './memory-governance.service';

@Injectable()
export class MemoryGovernanceProcessor {
  private readonly logger = new Logger(MemoryGovernanceProcessor.name);

  constructor(
    private readonly governanceService: MemoryGovernanceService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron('0 3 * * *')
  async scheduledCleanup(): Promise<void> {
    this.logger.log('Starting scheduled memory governance cleanup');
    const client = this.prisma.client as unknown as {
      project: { findMany(): Promise<{ id: string }[]> };
    };
    const projects = await client.project.findMany();
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
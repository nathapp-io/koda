import { SystemWriter } from '../permissions/system-writer.decorator';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { runAsSystemWriter } from '../action-context/action-context';
import { AuditRecorder, type AuditRecordInput } from '../audit/audit-recorder.service';
import { MemoryGovernanceService, type GovernanceResult } from './memory-governance.service';
import { ProjectsService } from '../projects/projects.service';

/**
 * The entries one project's governance run records: exactly one when the run changed rows, none when all four
 * counts are zero. Permissions P2 US-003 — a cleanup that expired, downranked, deduplicated or superseded nothing is
 * not a write, so it records nothing.
 */
export function governanceEntries(projectId: string, result: GovernanceResult): readonly AuditRecordInput[] {
  const changed =
    result.expiredCount > 0 ||
    result.downrankedCount > 0 ||
    result.deduplicatedCount > 0 ||
    result.supersessionCount > 0;
  if (!changed) return [];

  return [{
    key: 'system.memory.govern',
    resourceType: 'project',
    resourceId: projectId,
    projectId,
    summary: `expired ${result.expiredCount}, downranked ${result.downrankedCount}, deduplicated ${result.deduplicatedCount}, superseded ${result.supersessionCount}`,
  }];
}

@Injectable()
@SystemWriter('system.memory.govern')
export class MemoryGovernanceProcessor {
  private readonly logger = new Logger(MemoryGovernanceProcessor.name);

  constructor(
    private readonly governanceService: MemoryGovernanceService,
    private readonly projectsService: ProjectsService,
    private readonly audit: AuditRecorder,
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
        const result = await this.governanceService.runCleanup(project.id);
        // Permissions P2 US-003: the cleanup makes one small write per item outside any transaction, and wrapping a
        // whole project in one would risk the timeout — so the entry is recorded after the run resolves, in a
        // transaction of its own. A refused entry therefore leaves the cleanup's writes in place; it is this
        // project's failure, logged and collected like any other, and the next project still runs.
        await this.audit.audited(
          async () => result,
          (counts) => governanceEntries(project.id, counts),
        );
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

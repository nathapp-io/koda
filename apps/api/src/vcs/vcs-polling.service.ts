import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { VcsConnection, Project } from '@prisma/client';
import { decryptToken } from '../common/utils/encryption.util';
import { createVcsProvider } from './factory';
import { VcsSyncService } from './vcs-sync.service';

/**
 * Polling service for syncing issues on a schedule
 */
@Injectable()
export class VcsPollingService implements OnModuleInit {
  private readonly logger = new Logger(VcsPollingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly syncService: VcsSyncService,
  ) {}

  private get db(): any {
    return this.prisma.client;
  }

  async onModuleInit() {
    // Initialize polling for all active connections with polling mode
    await this.initializePolling();
  }

  /**
   * Initialize polling intervals for all polling connections
   */
  private async initializePolling(): Promise<void> {
    const connections = await this.db.vcsConnection.findMany({
      where: {
        syncMode: 'polling',
        isActive: true,
      },
      include: {
        project: true,
      },
    });

    for (const connection of connections) {
      this.schedulePolling(connection);
    }
  }

  /**
   * Schedule polling for a specific connection
   */
  schedulePolling(connection: VcsConnection & { project: Project }): void {
    const scheduleName = `vcs-polling-${connection.id}`;

    // Remove existing interval if it exists
    try {
      this.schedulerRegistry.deleteInterval(scheduleName);
    } catch {
      // Interval doesn't exist yet, that's fine
    }

    // Create interval
    const interval = setInterval(async () => {
      await this.poll(connection);
    }, connection.pollingIntervalMs);

    this.schedulerRegistry.addInterval(scheduleName, interval);
    this.logger.debug(`Scheduled polling for connection ${connection.id} every ${connection.pollingIntervalMs}ms`);
  }

  /**
   * Poll a single connection for new issues
   */
  private async poll(connection: VcsConnection & { project: Project }): Promise<void> {
    const startTime = new Date();

    try {
      // Get encryption key from env
      const encryptionKey = process.env.VCS_ENCRYPTION_KEY;
      if (!encryptionKey) {
        throw new Error('VCS encryption key not configured');
      }

      // Decrypt token
      const decryptedToken = decryptToken(connection.encryptedToken, encryptionKey);

      // Create provider
      const provider = createVcsProvider(connection.provider, {
        provider: connection.provider,
        token: decryptedToken,
        repoUrl: `https://github.com/${connection.repoOwner}/${connection.repoName}`,
      });

      // Fetch issues since last sync
      const issues = await provider.fetchIssues(connection.lastSyncedAt ?? undefined);

      // Filter by allowed authors
      const filteredIssues = this.syncService.filterByAllowedAuthors(
        issues,
        connection.allowedAuthors,
      );

      // Sync each issue
      let issuesSynced = 0;
      let issuesSkipped = 0;

      for (const issue of filteredIssues) {
        const result = await this.syncService.syncIssue(connection.project, issue, 'polling');
        if (result.action === 'created') {
          issuesSynced++;
        } else {
          issuesSkipped++;
        }
      }

      // Update connection lastSyncedAt
      await this.db.vcsConnection.update({
        where: { id: connection.id },
        data: { lastSyncedAt: new Date() },
      });

      // Write sync log
      await this.db.vcsSyncLog.create({
        data: {
          vcsConnectionId: connection.id,
          syncType: 'issues',
          issuesSynced,
          issuesSkipped,
          startedAt: startTime,
          completedAt: new Date(),
        },
      });

      this.logger.debug(
        `Polling complete for connection ${connection.id}: synced=${issuesSynced}, skipped=${issuesSkipped}`,
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Write sync log with error
      await this.db.vcsSyncLog.create({
        data: {
          vcsConnectionId: connection.id,
          syncType: 'issues',
          issuesSynced: 0,
          issuesSkipped: 0,
          errorMessage,
          startedAt: startTime,
          completedAt: new Date(),
        },
      });

      this.logger.error(`Polling failed for connection ${connection.id}: ${errorMessage}`);
      // Don't update lastSyncedAt on error - will retry on next interval
    }
  }
}

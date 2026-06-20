import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { VcsConnectionWithProjectDomain } from './domain/vcs.domain';
import { decryptToken } from '../common/utils/encryption.util';
import { createVcsProvider } from './factory';
import { VcsSyncService } from './vcs-sync.service';
import { VcsPrSyncService } from './vcs-pr-sync.service';
import { IVcsRepository, VCS_REPOSITORY } from './domain/vcs.repository';
import { VCS_CFG, IVcsConfig } from '../config/vcs.config';

/**
 * Polling service for syncing issues on a schedule
 */
@Injectable()
export class VcsPollingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VcsPollingService.name);
  private readonly scheduledConnectionIds = new Set<string>();

  constructor(
    @Inject(VCS_REPOSITORY) private readonly vcsRepo: IVcsRepository,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly syncService: VcsSyncService,
    private readonly prSyncService: VcsPrSyncService,
    @Inject(VCS_CFG) private readonly vcsConfig: IVcsConfig,
  ) {}

  async onModuleInit() {
    // Initialize polling for all active connections with polling mode
    await this.initializePolling();
  }

  async onModuleDestroy(): Promise<void> {
    for (const connectionId of this.scheduledConnectionIds) {
      this.unschedulePolling(connectionId);
    }
  }

  /**
   * Initialize polling intervals for all polling connections
   */
  private async initializePolling(): Promise<void> {
    const connections = await this.vcsRepo.findPollingConnections();

    // Filter again in code for resilience (ensures only polling and active connections)
    const pollingConnections = connections.filter(
      (conn) => conn.syncMode === 'polling' && conn.isActive === true,
    );

    for (const connection of pollingConnections) {
      this.schedulePolling(connection);
    }
  }

  /**
   * Schedule polling for a specific connection
   */
  schedulePolling(connection: VcsConnectionWithProjectDomain): void {
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
    this.scheduledConnectionIds.add(connection.id);
    this.logger.debug(`Scheduled polling for connection ${connection.id} every ${connection.pollingIntervalMs}ms`);
  }

  unschedulePolling(connectionId: string): void {
    const scheduleName = `vcs-polling-${connectionId}`;
    try {
      this.schedulerRegistry.deleteInterval(scheduleName);
    } catch {
      // Nothing to remove.
    }
    this.scheduledConnectionIds.delete(connectionId);
  }

  async refreshConnectionSchedule(connectionId: string): Promise<void> {
    this.unschedulePolling(connectionId);

    const connection = await this.vcsRepo.findVcsConnectionById(connectionId);

    if (!connection || connection.syncMode !== 'polling' || !connection.isActive) {
      return;
    }

    this.schedulePolling(connection);
  }

  /**
   * Poll a single connection for new issues
   */
  private async poll(connection: VcsConnectionWithProjectDomain): Promise<void> {
    const startTime = new Date();

    try {
      // Get encryption key from config
      const encryptionKey = this.vcsConfig.encryptionKey;
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
      await this.vcsRepo.updateVcsConnectionLastSynced(connection.id);

      // Write sync log
      await this.vcsRepo.createVcsSyncLog({
        vcsConnectionId: connection.id,
        syncType: 'polling',
        issuesSynced,
        issuesSkipped,
        startedAt: startTime,
        completedAt: new Date(),
      });

      this.logger.debug(
        `Polling complete for connection ${connection.id}: synced=${issuesSynced}, skipped=${issuesSkipped}`,
      );

      // Sync PR statuses after issue sync completes
      const prResult = await this.prSyncService.syncPrStatus(
        connection.project,
        connection,
        encryptionKey,
      );
      this.logger.debug(
        `PR sync complete for connection ${connection.id}: updated=${prResult.updated}, skipped=${prResult.skipped}`,
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Write sync log with error
      await this.vcsRepo.createVcsSyncLog({
        vcsConnectionId: connection.id,
        syncType: 'polling',
        issuesSynced: 0,
        issuesSkipped: 0,
        errorMessage,
        startedAt: startTime,
        completedAt: new Date(),
      });

      this.logger.error(`Polling failed for connection ${connection.id}: ${errorMessage}`);
      // Don't update lastSyncedAt on error - will retry on next interval
    }
  }
}

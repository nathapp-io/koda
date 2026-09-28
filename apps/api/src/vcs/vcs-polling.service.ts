import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { VcsConnectionWithProjectDomain } from './domain/vcs.domain';
import { decryptToken } from '../common/utils/encryption.util';
import { providerForConnection } from './provider-for-connection';
import { VcsSyncService } from './vcs-sync.service';
import { VcsPrSyncService } from './vcs-pr-sync.service';
import { IVcsRepository, VCS_REPOSITORY } from './domain/vcs.repository';
import { VCS_CFG, IVcsConfig } from '../config/vcs.config';
import { ISSUES_PER_PAGE, MAX_ISSUE_PAGES } from './providers/pagination';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : 'Unknown error');

/** Sync-log warning for a fetch that hit MAX_ISSUE_PAGES. */
function cappedWarning(cursor: Date | null): string {
  const from = cursor ? cursor.toISOString() : 'the previous cursor';
  return `Issue fetch capped at ${MAX_ISSUE_PAGES} pages of ${ISSUES_PER_PAGE}; the next poll resumes from ${from}`;
}

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

    // M10: each tick re-reads the connection, so it polls with the current token,
    // cursor and mode, and stops once the connection is gone.
    const interval = setInterval(() => {
      void this.tick(connection.id);
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

  /** One polling tick. Never rejects: an interval callback has no caller to catch it. */
  private async tick(connectionId: string): Promise<void> {
    try {
      const connection = await this.vcsRepo.findVcsConnectionById(connectionId);
      if (!connection || !connection.isActive || connection.syncMode !== 'polling') {
        this.unschedulePolling(connectionId);
        return;
      }
      await this.poll(connection);
    } catch (error) {
      this.logger.error(`Polling tick failed for connection ${connectionId}: ${messageOf(error)}`);
    }
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
      const provider = providerForConnection(connection, decryptedToken, this.vcsConfig);

      // Fetch issues since last sync
      const { issues, cursor, capped } = await provider.fetchIssues(connection.lastSyncedAt ?? undefined);

      // Filter by allowed authors
      const filteredIssues = this.syncService.filterByAllowedAuthors(
        issues,
        connection.allowedAuthors,
      );

      // Sync each issue
      let issuesSynced = 0;
      let issuesSkipped = 0;

      for (const issue of filteredIssues) {
        const result = await this.syncService.syncIssue(connection.project, issue, 'polling', connection);
        if (result.action === 'created') {
          issuesSynced++;
        } else {
          issuesSkipped++;
        }
      }

      // M10: resume from the newest issue update seen, not from "now", so a capped
      // poll picks up where it stopped. Nothing seen keeps the old cursor.
      if (cursor) {
        await this.vcsRepo.updateVcsConnectionLastSynced(connection.id, cursor);
      }

      // Write sync log
      await this.vcsRepo.createVcsSyncLog({
        vcsConnectionId: connection.id,
        syncType: 'polling',
        issuesSynced,
        issuesSkipped,
        ...(capped ? { errorMessage: cappedWarning(cursor) } : {}),
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
      const errorMessage = messageOf(error);
      this.logger.error(`Polling failed for connection ${connection.id}: ${errorMessage}`);
      // VCS LOW: the error-path log write is guarded too; an interval callback
      // that rejects is an unhandled rejection. lastSyncedAt is not moved, so
      // the next tick retries from the same cursor.
      try {
        await this.vcsRepo.createVcsSyncLog({
          vcsConnectionId: connection.id,
          syncType: 'polling',
          issuesSynced: 0,
          issuesSkipped: 0,
          errorMessage,
          startedAt: startTime,
          completedAt: new Date(),
        });
      } catch (logError) {
        this.logger.error(`Failed to write the polling sync log for connection ${connection.id}: ${messageOf(logError)}`);
      }
    }
  }
}

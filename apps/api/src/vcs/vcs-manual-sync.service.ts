import { isDeepStrictEqual } from 'node:util';
import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ProjectsService } from '../projects/projects.service';
import { VCS_CFG, type IVcsConfig } from '../config/vcs.config';
import { decryptToken } from '../common/utils/encryption.util';
import { VcsConnectionService, vcsTestTarget } from './vcs-connection.service';
import { VcsSyncService } from './vcs-sync.service';
import { VcsPrSyncService, type ApplyPrStatusesResult } from './vcs-pr-sync.service';
import { providerForConnection } from './provider-for-connection';
import type { VcsConnectionDomain } from './domain/vcs.domain';
import type { VcsIssue } from './types';
import type { SyncResultDto } from './dto/sync-result.dto';

/** External reads happen before the approval execution transaction, never in its apply callback. */
@Injectable()
export class VcsManualSync {
  constructor(
    private readonly projects: ProjectsService,
    private readonly connections: VcsConnectionService,
    private readonly sync: VcsSyncService,
    @Inject(VCS_CFG) private readonly config: IVcsConfig,
    private readonly prSync: VcsPrSyncService,
  ) {}

  private encryptionKey(): string {
    if (!this.config.encryptionKey) throw new ValidationAppException({}, 'vcs');
    return this.config.encryptionKey;
  }

  private async target(slug: string) {
    const project = await this.projects.findBySlug(slug);
    const key = this.encryptionKey();
    const connection = await this.connections.getFullByProject(project.id);
    return { project, connection, key };
  }

  private async assertTarget(projectId: string, connection: VcsConnectionDomain, authors: boolean) {
    const current = await this.connections.getFullByProject(projectId, { lock: true }).catch((error: unknown) => {
      if (error instanceof NotFoundAppException) throw new ValidationAppException({}, 'vcs');
      throw error;
    });
    if (!isDeepStrictEqual(vcsTestTarget(current), vcsTestTarget(connection)) ||
      (authors && current.allowedAuthors !== connection.allowedAuthors)) {
      throw new ValidationAppException({}, 'vcs');
    }
  }

  async syncIssue(slug: string, issueNumber: string): Promise<SyncResultDto> {
    const { project, connection, key } = await this.target(slug);
    const provider = providerForConnection(connection, decryptToken(connection.encryptedToken, key), this.config);
    const issue = await provider.fetchIssue(parseInt(issueNumber, 10));
    return this.applyIssue(project, connection, issue);
  }

  async prepareSyncIssue(slug: string, issueNumber: string): Promise<() => Promise<SyncResultDto>> {
    const { project, connection, key } = await this.target(slug);
    const provider = providerForConnection(connection, decryptToken(connection.encryptedToken, key), this.config);
    const issue = await provider.fetchIssue(parseInt(issueNumber, 10));
    return async () => {
      await this.assertTarget(project.id, connection, false);
      return this.applyIssue(project, connection, issue);
    };
  }

  private async applyIssue(project: { id: string; key: string }, connection: VcsConnectionDomain, issue: VcsIssue): Promise<SyncResultDto> {
    // A single explicit import ignores allowedAuthors, matching the existing manual endpoint.
    const result = await this.sync.syncIssue(project, issue, 'manual', connection, 'vcs.sync.issue');
    // Keep the existing public 409 contract (also fails a deferred execution).
    if (result.action === 'skipped') throw new HttpException('Issue already synced', HttpStatus.CONFLICT);
    return {
      syncType: 'manual', issuesSynced: 1, issuesSkipped: 0,
      tickets: result.ticketNumber ? [{ ref: `${project.key}-${result.ticketNumber}`, title: issue.title }] : [],
    };
  }

  async syncAll(slug: string): Promise<SyncResultDto> {
    const { project, connection, key } = await this.target(slug);
    return this.summary(project, await this.sync.fullSync(project, connection, key));
  }

  async prepareSyncAll(slug: string): Promise<() => Promise<SyncResultDto>> {
    const { project, connection, key } = await this.target(slug);
    const provider = providerForConnection(connection, decryptToken(connection.encryptedToken, key), this.config);
    const { issues } = await provider.fetchIssues();
    const filtered = this.sync.filterByAllowedAuthors(issues, connection.allowedAuthors);
    return async () => {
      await this.assertTarget(project.id, connection, true);
      const result = await this.sync.syncIssues(project, filtered, connection, 'vcs.sync.all', { isolate: false });
      return this.summary(project, result);
    };
  }

  async syncPr(slug: string): Promise<ApplyPrStatusesResult> {
    const { project, connection, key } = await this.target(slug);
    const result = await this.prSync.syncPrStatus(project, connection, key, 'vcs.sync.pr');
    // Immediate sync already started its background extractions.
    return { ...result, extractions: [] };
  }

  async prepareSyncPr(slug: string): Promise<() => Promise<ApplyPrStatusesResult>> {
    const { project, connection, key } = await this.target(slug);
    const fetched = await this.prSync.fetchPrStatuses(project, connection, key);
    return async () => {
      await this.assertTarget(project.id, connection, false);
      return this.prSync.applyPrStatuses(project, connection, key, fetched, 'vcs.sync.pr', { isolate: false });
    };
  }

  async startPrExtractions(result: ApplyPrStatusesResult): Promise<void> {
    this.prSync.startExtractions(result.extractions);
  }

  private summary(project: { key: string }, result: Awaited<ReturnType<VcsSyncService['fullSync']>>): SyncResultDto {
    return {
      syncType: 'manual', issuesSynced: result.issuesSynced, issuesSkipped: result.issuesSkipped,
      tickets: result.createdTickets.map((ticket) => ({ ref: `${project.key}-${ticket.number}`, title: ticket.title })),
    };
  }
}

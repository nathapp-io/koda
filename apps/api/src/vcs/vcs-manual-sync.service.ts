import { isDeepStrictEqual } from 'node:util';
import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ProjectsService } from '../projects/projects.service';
import { VCS_CFG, type IVcsConfig } from '../config/vcs.config';
import { decryptToken } from '../common/utils/encryption.util';
import { AfterCommitService } from '../permissions/after-commit.service';
import { VcsConnectionService, vcsTestTarget } from './vcs-connection.service';
import { VcsSyncService, VcsTargetDriftError } from './vcs-sync.service';
import { VcsPrSyncService, type ApplyPrStatusesResult } from './vcs-pr-sync.service';
import { providerForConnection } from './provider-for-connection';
import type { VcsConnectionDomain } from './domain/vcs.domain';
import type { VcsIssue } from './types';
import type { SyncResultDto } from './dto/sync-result.dto';

/** How many isolated issue failures one deferred pass names in its error log before it summarises. */
const FULL_IMPORT_LOGGED_FAILURES = 10;

/** External reads happen before the approval execution transaction, never in its apply callback. */
@Injectable()
export class VcsManualSync {
  private readonly logger = new Logger(VcsManualSync.name);

  constructor(
    private readonly projects: ProjectsService,
    private readonly connections: VcsConnectionService,
    private readonly sync: VcsSyncService,
    @Inject(VCS_CFG) private readonly config: IVcsConfig,
    private readonly prSync: VcsPrSyncService,
    private readonly afterCommit: AfterCommitService,
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

  /**
   * Review 2026-11-14 (BUG-2): an approved full import runs as its own isolated pass after the approval
   * transaction commits, instead of inside that transaction with `isolate: false`.
   *
   * The fetch of up to a thousand issues cannot be undone by a rollback, and one failed issue write rolled
   * the whole import back. So the prepared closure only rechecks the target and queues the pass with
   * `AfterCommitService.defer`: it runs once the approval committed, and every issue write is isolated.
   * What the approval records is what the fetch learned — how many issues the import will process and
   * whether the provider had more — because no preview can know that before the request executes.
   *
   * A rejected deferred pass is not the approval's failure: the approval is already durable, so the pass
   * reports through the log — as do the per-issue failures `isolate` collects instead of rejecting.
   * `defer` answering false means no transaction owns this call — nothing has committed, so a failure
   * there is the caller's.
   *
   * Review-1119 (US-006, B1): the target check the closure runs happens inside the approval's transaction,
   * and that lock is released with it. The pass therefore revalidates the same captured connection and
   * author filter inside every issue write's own transaction (`revalidateTarget`), so a disconnect, a
   * repository change or a tightened `allowedAuthors` that commits in between lands before a write that
   * would import from the old target: that write is refused, nothing is written, and the pass stops.
   */
  async prepareSyncAll(slug: string): Promise<() => Promise<SyncResultDto>> {
    const { project, connection, key } = await this.target(slug);
    const provider = providerForConnection(connection, decryptToken(connection.encryptedToken, key), this.config);
    const { issues, capped } = await provider.fetchIssues();
    const filtered = this.sync.filterByAllowedAuthors(issues, connection.allowedAuthors);
    const revalidateTarget = async () => {
      try {
        await this.assertTarget(project.id, connection, true);
      } catch (error) {
        if (error instanceof ValidationAppException) throw new VcsTargetDriftError();
        throw error;
      }
    };
    const importIssues = async () => {
      const { errors, stopped } = await this.sync.syncIssues(
        project, filtered, connection, 'vcs.sync.all', { isolate: true, revalidate: revalidateTarget },
      );
      // The refusal that ended the pass is the one thing the truncated summary cannot carry: it is
      // reported on its own line, with its reason, whatever the per-issue failures before it.
      if (stopped !== undefined) this.logImportStopped(project.id, stopped);
      this.logImportFailures(project.id, errors);
    };
    return async () => {
      await this.assertTarget(project.id, connection, true);
      const deferred = this.afterCommit.defer(async () => {
        try {
          await importIssues();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`VCS full import failed for project ${project.id}: ${message}`);
        }
      });
      if (!deferred) await importIssues();
      return {
        syncType: 'manual', issuesSynced: 0, issuesSkipped: 0, tickets: [],
        fetchedIssues: filtered.length, capped,
      };
    };
  }

  /**
   * The pass stopped before the last fetched issue: a target-drift refusal, whose reason is the whole
   * report of what happened to the remaining issues (review-1119 US-006, B1). It is logged on its own
   * line because `logImportFailures` truncates its list — ten ordinary failures before the drift would
   * otherwise push the reason out of the log.
   */
  private logImportStopped(projectId: string, reason: string): void {
    this.logger.error(`VCS full import for project ${projectId} stopped: ${reason}`);
  }

  /**
   * `isolate` turns a failed issue write into an entry of the summary instead of a rejection, so these
   * entries are the only report a partially failed import gives: without this, a pass that imported
   * nothing but skipped every issue would look like a successful one. The message is bounded because the
   * array can hold one entry per fetched issue (up to a thousand), so the entry that stopped the pass is
   * not in it (`logImportStopped`).
   */
  private logImportFailures(projectId: string, errors: string[]): void {
    if (errors.length === 0) return;
    const shown = errors.slice(0, FULL_IMPORT_LOGGED_FAILURES).join('; ');
    const rest = errors.length - FULL_IMPORT_LOGGED_FAILURES;
    this.logger.error(
      `VCS full import for project ${projectId} failed ${errors.length} issue(s): ${shown}` +
      (rest > 0 ? `; … and ${rest} more` : ''),
    );
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

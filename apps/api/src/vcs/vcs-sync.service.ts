import { Inject, Injectable, Optional } from '@nestjs/common';
import type { VcsConnectionDomain } from './domain/vcs.domain';
import { VcsIssue } from './types';
import { providerForConnection } from './provider-for-connection';
import { decryptToken } from '../common/utils/encryption.util';
import { IVcsRepository, VCS_REPOSITORY } from './domain/vcs.repository';
import { externalVcsIdFor, VcsRepoRef } from './external-vcs-id';
import { VCS_CFG, IVcsConfig } from '../config/vcs.config';
import { AuditRecorder } from '../audit/audit-recorder.service';
import type { VcsIssueAuditKey } from './vcs-audit';

/**
 * Result of syncing a single issue
 */
export interface SyncIssueResult {
  action: 'created' | 'skipped';
  ticketId?: string;
  ticketNumber?: number;
  ticketTitle?: string;
  reason?: string;
}

@Injectable()
export class VcsSyncService {
  constructor(
    @Inject(VCS_REPOSITORY) private readonly vcsRepo: IVcsRepository,
    private readonly audit: AuditRecorder,
    @Optional() @Inject(VCS_CFG) private readonly vcsConfig?: IVcsConfig,
  ) {}

  /**
   * Sync a single issue into a ticket.
   *
   * Permissions P2 US-002: `auditKey` is the entry point that ran this (a sync route, the poller or the
   * webhook intake), so an import's entry names where the outside write came from.
   */
  async syncIssue(
    project: { id: string },
    issue: VcsIssue,
    syncMode: 'manual' | 'polling' | 'webhook',
    repo: VcsRepoRef,
    auditKey: VcsIssueAuditKey,
  ): Promise<SyncIssueResult> {
    const externalVcsId = externalVcsIdFor(repo, issue.number);

    // Dedup includes soft-deleted tickets (M11): a deleted import stays deleted.
    const existingTicket = await this.vcsRepo.findExistingTicketByExternalId(project.id, externalVcsId);

    if (existingTicket) {
      return {
        action: 'skipped',
        reason: 'Ticket with this external VCS ID already exists',
      };
    }

    // Allocate ticket number in transaction and create ticket. The entry is recorded inside that
    // attempt's transaction through the callback: wrapping the call in `audited` would start an outer
    // transaction, and `runWithTicketNumberRetry` refuses to retry inside one.
    const result = await this.vcsRepo.createTicketFromIssue(project, issue, externalVcsId, async (ticket) => {
      await this.audit.record({
        key: auditKey,
        resourceType: 'ticket',
        resourceId: ticket.id,
        projectId: project.id,
        summary: `imported issue #${issue.number}`,
      });
    });

    return {
      action: 'created',
      ticketId: result.id,
      ticketNumber: result.number,
      ticketTitle: result.title,
    };
  }

  /**
   * Filter issues by allowedAuthors
   */
  filterByAllowedAuthors(issues: VcsIssue[], allowedAuthorsJson: string): VcsIssue[] {
    try {
      const allowedAuthors = JSON.parse(allowedAuthorsJson) as string[];

      // If allowed authors list is empty, allow all
      if (allowedAuthors.length === 0) {
        return issues;
      }

      // Filter issues by author
      return issues.filter((issue) => allowedAuthors.includes(issue.authorLogin));
    } catch {
      // If parsing fails, allow all issues
      return issues;
    }
  }

  /**
   * Perform a full sync of all issues from the provider
   */
  async fullSync(
    project: { id: string; key: string },
    connection: VcsConnectionDomain,
    encryptionKey: string,
  ): Promise<{
    issuesSynced: number;
    issuesSkipped: number;
    createdTickets: Array<{ id: string; number: number; title: string }>;
    errors: string[];
  }> {
    const createdTickets: Array<{ id: string; number: number; title: string }> = [];
    const errors: string[] = [];
    let issuesSynced = 0;
    let issuesSkipped = 0;

    try {
      // Decrypt token
      const decryptedToken = decryptToken(connection.encryptedToken, encryptionKey);

      // Create provider
      const provider = providerForConnection(connection, decryptedToken, this.vcsConfig);

      // Fetch all issues
      const { issues } = await provider.fetchIssues();

      // Filter by allowed authors
      const filteredIssues = this.filterByAllowedAuthors(issues, connection.allowedAuthors);

      // Sync each issue
      for (const issue of filteredIssues) {
        try {
          const result = await this.syncIssue(project, issue, 'manual', connection, 'vcs.sync.all');
          if (result.action === 'created') {
            issuesSynced++;
            if (result.ticketId && result.ticketNumber) {
              createdTickets.push({
                id: result.ticketId,
                number: result.ticketNumber,
                title: result.ticketTitle ?? issue.title,
              });
            }
          } else {
            issuesSkipped++;
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          errors.push(`Issue ${issue.number}: ${errorMsg}`);
          issuesSkipped++;
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      errors.push(`Sync failed: ${errorMsg}`);
    }

    return {
      issuesSynced,
      issuesSkipped,
      createdTickets,
      errors,
    };
  }
}

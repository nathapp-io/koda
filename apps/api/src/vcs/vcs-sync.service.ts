import { Injectable } from '@nestjs/common';
import { Project, VcsConnection } from '@prisma/client';
import { VcsIssue } from './types';
import { createVcsProvider } from './factory';
import { decryptToken } from '../common/utils/encryption.util';
import { PrismaVcsRepository } from './prisma-vcs.repository';

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
  constructor(private readonly vcsRepo: PrismaVcsRepository) {}

  /**
   * Sync a single issue into a ticket
   */
  async syncIssue(
    project: Project,
    issue: VcsIssue,
    syncMode: 'manual' | 'polling' | 'webhook',
  ): Promise<SyncIssueResult> {
    // Check if issue already exists (deduplication)
    const existingTicket = await this.vcsRepo.findExistingTicketByExternalId(
      project.id,
      `${issue.number}`,
    );

    if (existingTicket) {
      return {
        action: 'skipped',
        reason: 'Ticket with this external VCS ID already exists',
      };
    }

    // Allocate ticket number in transaction and create ticket
    const result = await this.vcsRepo.createTicketFromIssue(project, issue);

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
    project: Project,
    connection: VcsConnection,
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
      const provider = createVcsProvider(connection.provider, {
        provider: connection.provider,
        token: decryptedToken,
        repoUrl: `https://github.com/${connection.repoOwner}/${connection.repoName}`,
      });

      // Fetch all issues
      const issues = await provider.fetchIssues();

      // Filter by allowed authors
      const filteredIssues = this.filterByAllowedAuthors(issues, connection.allowedAuthors);

      // Sync each issue
      for (const issue of filteredIssues) {
        try {
          const result = await this.syncIssue(project, issue, 'manual');
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

/**
 * VcsLinkExtractorService
 *
 * Extracts branch and commit links from pull requests and creates TicketLink entries.
 * - Creates TicketLink with linkType='branch' for PR head branch URL
 * - Creates TicketLink entries with linkType='commit' for commits matching ticket ref
 * - Upserts on @@unique([ticketId, url]) to avoid duplicates
 * - Gracefully handles GitHub API failures during commit listing
 */
import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import type { VcsConnectionDomain, VcsTicketDomain } from './domain/vcs.domain';
import { PrismaVcsRepository } from './prisma-vcs.repository';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { decryptToken } from '../common/utils/encryption.util';
import { providerForConnection, branchWebUrl } from './provider-for-connection';
import { containsTicketRef } from './ticket-ref-matcher.util';
import { VCS_CFG, IVcsConfig } from '../config/vcs.config';

@Injectable()
export class VcsLinkExtractorService {
  private readonly logger = new Logger(VcsLinkExtractorService.name);

  constructor(
    private readonly vcsRepo: PrismaVcsRepository,
    private readonly audit: AuditRecorder,
    @Optional() @Inject(VCS_CFG) private readonly vcsConfig?: IVcsConfig,
  ) {}

  /**
   * Extract branch and commit links from a pull request and create TicketLink entries.
   *
   * @param project The project (must have id and key)
   * @param ticket The ticket to link
   * @param connection The VCS connection
   * @param encryptionKey The encryption key for decrypting the token
   * @param branchName The head branch name of the PR
   * @param prNumber The number of the pull request to extract links from (required)
   */
  async extractLinksFromPr(
    project: { id: string; key: string },
    ticket: VcsTicketDomain,
    connection: VcsConnectionDomain,
    encryptionKey: string,
    branchName: string,
    prNumber: number,
  ): Promise<void> {
    const provider = providerForConnection(
      connection,
      decryptToken(connection.encryptedToken, encryptionKey),
      this.vcsConfig,
    );

    // Get PR status to obtain the actual PR number and verify the PR exists
    const prStatus = await provider.getPullRequestStatus(prNumber);

    // Create branch link URL on the connection's host (/tree/ or /-/tree/)
    const branchUrl = branchWebUrl(connection, branchName, this.vcsConfig);

    // Upsert branch link
    await this.upsertTicketLink(project, ticket, branchUrl, connection.provider, 'branch', branchName);

    // Try to list commits and create commit links
    let commits: { sha: string; message: string; authorLogin: string; url: string; date: Date }[] = [];
    try {
      commits = await provider.listPrCommits(prStatus.number);
    } catch (err) {
      this.logger.warn(
        `[link-extractor] Failed to list PR commits for ticket ${ticket.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Branch link is already created, so we just return early
      return;
    }

    // Filter commits that contain the ticket reference
    const matchingCommits = commits.filter(commit =>
      containsTicketRef(commit.message, project.key, ticket.number),
    );

    // Deduplicate by URL to avoid creating duplicate commit links
    const seenUrls = new Set<string>();
    const uniqueCommits = matchingCommits.filter(commit => {
      if (seenUrls.has(commit.url)) return false;
      seenUrls.add(commit.url);
      return true;
    });

    // Create commit links for matching commits
    for (const commit of uniqueCommits) {
      await this.upsertTicketLink(project, ticket, commit.url, connection.provider, 'commit', commit.message, commit.date);
    }
  }

  /**
   * Permissions P2 US-005: a link this extractor creates is a write an outside system caused, so it
   * records `ticket.link.add` — the key audit-core records the same row under through the REST route —
   * as the current actor. The update branch (`null`) is bookkeeping and records nothing.
   */
  private async upsertTicketLink(
    project: { id: string; key: string },
    ticket: VcsTicketDomain,
    url: string,
    provider: string,
    linkType: string,
    externalRef?: string,
    createdAt?: Date,
  ): Promise<void> {
    await this.audit.audited(
      () => this.vcsRepo.upsertTicketLink(ticket.id, url, provider, linkType, externalRef, createdAt),
      (linkId) => (linkId
        ? {
            key: 'ticket.link.add', resourceType: 'ticket-link', resourceId: linkId,
            projectId: project.id, summary: `on ${project.key}-${ticket.number}`,
          }
        : []),
    );
  }
}

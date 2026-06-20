/**
 * VcsLinkExtractorService
 *
 * Extracts branch and commit links from pull requests and creates TicketLink entries.
 * - Creates TicketLink with linkType='branch' for PR head branch URL
 * - Creates TicketLink entries with linkType='commit' for commits matching ticket ref
 * - Upserts on @@unique([ticketId, url]) to avoid duplicates
 * - Gracefully handles GitHub API failures during commit listing
 */
import { Injectable, Logger } from '@nestjs/common';
import type { VcsConnectionDomain, VcsTicketDomain } from './domain/vcs.domain';
import { PrismaVcsRepository } from './prisma-vcs.repository';
import { decryptToken } from '../common/utils/encryption.util';
import { createVcsProvider } from './factory';
import { containsTicketRef } from './ticket-ref-matcher.util';

@Injectable()
export class VcsLinkExtractorService {
  private readonly logger = new Logger(VcsLinkExtractorService.name);

  constructor(private readonly vcsRepo: PrismaVcsRepository) {}

  /**
   * Extract branch and commit links from a pull request and create TicketLink entries.
   *
   * @param project The project (must have id and key)
   * @param ticket The ticket to link
   * @param connection The VCS connection
   * @param encryptionKey The encryption key for decrypting the token
   * @param branchName The head branch name of the PR
   */
  async extractLinksFromPr(
    project: { id: string; key: string },
    ticket: VcsTicketDomain,
    connection: VcsConnectionDomain,
    encryptionKey: string,
    branchName: string,
    prNumber?: number,
  ): Promise<void> {
    const provider = createVcsProvider(connection.provider, {
      provider: connection.provider,
      token: decryptToken(connection.encryptedToken, encryptionKey),
      repoUrl: `https://github.com/${connection.repoOwner}/${connection.repoName}`,
    });

    // Get PR number from externalVcsId (format: "owner/repo#123" or just "123")
    // Extract any trailing digits as the PR number
    let resolvedPrNumber = prNumber ?? 0;
    if (!resolvedPrNumber && ticket.externalVcsId) {
      const match = ticket.externalVcsId.match(/(\d+)$/);
      if (match) {
        resolvedPrNumber = parseInt(match[1], 10);
      }
    }

    // Get PR status to obtain the actual PR number and verify the PR exists
    const prStatus = await provider.getPullRequestStatus(resolvedPrNumber);

    // Create branch link URL: https://github.com/{owner}/{repo}/tree/{branchName}
    const branchUrl = `https://github.com/${connection.repoOwner}/${connection.repoName}/tree/${branchName}`;

    // Upsert branch link
    await this.upsertTicketLink(ticket.id, branchUrl, 'github', 'branch', branchName);

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
      await this.upsertTicketLink(ticket.id, commit.url, 'github', 'commit', commit.message, commit.date);
    }
  }

  private async upsertTicketLink(
    ticketId: string,
    url: string,
    provider: string,
    linkType: string,
    externalRef?: string,
    createdAt?: Date,
  ): Promise<void> {
    await this.vcsRepo.upsertTicketLink(ticketId, url, provider, linkType, externalRef, createdAt);
  }
}

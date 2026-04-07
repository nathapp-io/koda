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
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Project, Ticket, VcsConnection } from '@prisma/client';
import { decryptToken } from '../common/utils/encryption.util';
import { createVcsProvider } from './factory';
import { containsTicketRef } from './ticket-ref-matcher.util';
import { IVcsProvider } from './vcs-provider';

@Injectable()
export class VcsLinkExtractorService {
  private readonly logger = new Logger(VcsLinkExtractorService.name);

  constructor(private readonly prisma: PrismaService) {}

  private get db() {
    return this.prisma.client;
  }

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
    ticket: Ticket,
    connection: VcsConnection,
    encryptionKey: string,
    branchName: string,
  ): Promise<void> {
    // TODO: Implementation not yet complete - this is a stub for test compilation
    throw new Error('VcsLinkExtractorService.extractLinksFromPr not yet implemented');
  }
}

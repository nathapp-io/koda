/**
 * VcsPrSyncService - Syncs PR status from VCS provider to TicketLink records
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import type { VcsConnectionDomain } from './domain/vcs.domain';
import { decryptToken } from '../common/utils/encryption.util';
import { createVcsProvider } from './factory';
import { VcsPrStatus } from './types';
import { TicketStatus, CommentType } from '../common/enums';
import { validateTransition } from '../tickets/state-machine/ticket-transitions';
import { VcsLinkExtractorService, VcsTicketRef } from './vcs-link-extractor.service';
import { IVcsRepository, TicketLinkData, VCS_REPOSITORY } from './domain/vcs.repository';

export interface SyncPrStatusResult {
  updated: number;
  skipped: number;
}

@Injectable()
export class VcsPrSyncService {
  private readonly logger = new Logger(VcsPrSyncService.name);

  constructor(
    @Inject(VCS_REPOSITORY) private readonly vcsRepo: IVcsRepository,
    @Optional() private readonly vcsLinkExtractorService?: VcsLinkExtractorService,
  ) {}

  /**
   * Sync PR status from VCS provider to TicketLink records
   *
   * Queries TicketLink entries with active PRs (prNumber IS NOT NULL,
   * prState NOT IN ('merged', 'closed')), fetches current PR status from
   * the VCS provider, and updates TicketLink.prState and prUpdatedAt
   * when the state has changed.
   *
   * Auto-transition on PR merge:
   * - When prState changes to 'merged' and ticket.status === 'IN_PROGRESS',
   *   the ticket is transitioned to 'VERIFY_FIX', a FIX_REPORT comment is created,
   *   and a VCS_PR_MERGED activity is logged
   * - When prState changes to 'merged' and ticket.status !== 'IN_PROGRESS',
   *   only prState is updated without transition
   * - Failures in auto-transition do not prevent prState from being persisted
   *
   * Per-PR error handling:
   * - General API error: skip the PR, continue with remaining PRs
   * - 404 NotFoundAppException: mark TicketLink.prState as 'closed'
   *
   * @param project The project to sync PRs for
   * @param connection The VCS connection
   * @param encryptionKey The encryption key for decrypting the token
   * @returns Summary of updated and skipped PR counts
   */
  async syncPrStatus(
    project: { id: string; key: string },
    connection: VcsConnectionDomain,
    encryptionKey: string,
  ): Promise<SyncPrStatusResult> {
    // Decrypt the token
    const decryptedToken = decryptToken(connection.encryptedToken, encryptionKey);

    // Create VCS provider
    const provider = createVcsProvider(connection.provider, {
      provider: connection.provider,
      token: decryptedToken,
      repoUrl: `https://github.com/${connection.repoOwner}/${connection.repoName}`,
    });

    // Query TicketLink entries with active PRs and their linked tickets
    const ticketLinks = (await this.vcsRepo.findActiveTicketLinksWithPrs(project.id)) as TicketLinkData[];

    let updated = 0;
    let skipped = 0;

    // Process each TicketLink
    for (const link of ticketLinks) {
      if (link.prNumber === null || link.prNumber === undefined) {
        continue;
      }
      const prNumber = link.prNumber;

      try {
        const prStatus = await provider.getPullRequestStatus(prNumber);

        // Map VcsPrStatus to prState
        const newPrState = this.mapPrState(prStatus);

        // Update if state differs
        if (newPrState !== link.prState) {
          // Handle auto-transition when PR is merged
          if (newPrState === 'merged') {
            await this.handleMergedPrAutoTransition(link, prStatus);
          }

          // Always update prState regardless of transition outcome
          await this.vcsRepo.updateTicketLinkPrState(link.id, newPrState);
          updated++;

          // AC6: After syncPrStatus() updates a TicketLink, extractLinksFromPr() is called
          // to pick up new commits from the PR
          if (this.vcsLinkExtractorService && link.ticket && prStatus.branchName) {
            const ticketData = link.ticket;
            const ticketForExtraction: VcsTicketRef = {
              id: ticketData.id,
              number: ticketData.number,
              externalVcsId: ticketData.externalVcsId,
            };

            this.vcsLinkExtractorService.extractLinksFromPr(
              { id: project.id, key: project.key },
              ticketForExtraction,
              connection,
              encryptionKey,
              prStatus.branchName,
              prStatus.number,
            ).catch((err) => {
              this.logger.warn(
                `[vcs-pr-sync] Failed to extract links for ticket ${ticketData.id}: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
          }
        }
      } catch (error) {
        if (error instanceof NotFoundAppException) {
          // 404: mark as closed
          await this.vcsRepo.updateTicketLinkPrState(link.id, 'closed');
          updated++;
        } else {
          // General API error: skip this PR
          skipped++;
        }
      }
    }

    return { updated, skipped };
  }

  /**
   * Handle auto-transition when a PR is merged
   *
   * When a PR transitions to 'merged':
   * - If the linked ticket is IN_PROGRESS, transition it to VERIFY_FIX,
   *   create a FIX_REPORT comment, and log VCS_PR_MERGED activity
   * - If the ticket is not IN_PROGRESS, no transition is attempted
   *
   * Note: Failures in this auto-transition do NOT prevent the caller
   * from updating prState - this method handles its own errors internally.
   */
  async handleMergedPrAutoTransition(
    link: TicketLinkData,
    prStatus: VcsPrStatus,
  ): Promise<void> {
    // If ticket is not IN_PROGRESS, skip auto-transition
    if (!link.ticket || link.ticket.status !== TicketStatus.IN_PROGRESS) {
      return;
    }

    try {
      // Validate the transition
      validateTransition(
        TicketStatus.IN_PROGRESS,
        TicketStatus.VERIFY_FIX,
        CommentType.FIX_REPORT,
      );

      await this.vcsRepo.applyMergedPrTransition({
        ticketId: link.ticketId,
        externalRef: link.externalRef,
        prUrl: prStatus.url,
        mergedBy: prStatus.mergedBy ?? null,
        mergeSha: prStatus.mergeSha ?? null,
      });
    } catch (error) {
      // Log the error but don't rethrow - auto-transition failure should not
      // prevent prState from being updated
      if (error instanceof ValidationAppException) {
        this.logger.warn(
          `[vcs-pr-sync] Auto-transition validation failed for ticket ${link.ticketId}: ${error.message}`,
        );
      } else {
        this.logger.error(
          `[vcs-pr-sync] Auto-transition failed for ticket ${link.ticketId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Maps VcsPrStatus to a prState string
   */
  private mapPrState(prStatus: VcsPrStatus): string {
    if (prStatus.merged) {
      return 'merged';
    }
    if (prStatus.state === 'open') {
      return prStatus.draft ? 'draft' : 'open';
    }
    return prStatus.state === 'closed' ? 'closed' : prStatus.state;
  }
}

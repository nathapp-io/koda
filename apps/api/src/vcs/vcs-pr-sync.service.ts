/**
 * VcsPrSyncService - Syncs PR status from VCS provider to TicketLink records
 */
import { Injectable, Logger } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Project, VcsConnection } from '@prisma/client';
import { decryptToken } from '../common/utils/encryption.util';
import { createVcsProvider } from './factory';
import { VcsPrStatus } from './types';
import { TicketStatus, CommentType, ActivityType } from '../common/enums';
import { validateTransition } from '../tickets/state-machine/ticket-transitions';

// PrismaClientLike from @nathapp/nestjs-prisma doesn't expose VCS models,
// but they exist at runtime. Define a delegate interface for proper typing.
interface TicketLinkDelegate {
  findMany<T = unknown>(options: Record<string, unknown>): Promise<T[]>
  update(options: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>
  findUnique(options: { where: Record<string, unknown> }): Promise<unknown>
}

interface TicketDelegate {
  findUnique(options: { where: Record<string, unknown> }): Promise<unknown>
  update(options: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>
}

interface CommentDelegate {
  create(options: { data: Record<string, unknown> }): Promise<unknown>
}

interface TicketActivityDelegate {
  create(options: { data: Record<string, unknown> }): Promise<unknown>
}

interface ExtendedPrismaClient {
  ticketLink: TicketLinkDelegate
  ticket: TicketDelegate
  comment: CommentDelegate
  ticketActivity: TicketActivityDelegate
  $transaction<T>(fn: (client: ExtendedPrismaClient) => Promise<T>): Promise<T>
  [key: string]: unknown
}

/**
 * TicketLink data returned from findMany
 */
interface TicketLinkData {
  id: string
  ticketId: string
  prNumber: number | null
  prState: string | null
  url: string
  externalRef: string | null
  ticket?: {
    id: string
    status: string
  }
}

export interface SyncPrStatusResult {
  updated: number;
  skipped: number;
}

@Injectable()
export class VcsPrSyncService {
  private readonly logger = new Logger(VcsPrSyncService.name);

  constructor(private readonly prisma: PrismaService) {}

  private get db() {
    return this.prisma as unknown as ExtendedPrismaClient;
  }

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
    project: Project,
    connection: VcsConnection,
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
    const ticketLinks = (await this.db.ticketLink.findMany({
      include: {
        ticket: {
          select: {
            id: true,
            status: true,
          },
        },
      },
      where: {
        prNumber: { not: null },
        prState: { notIn: ['merged', 'closed'] },
        ticket: {
          projectId: project.id,
          deletedAt: null,
        },
      },
    })) as TicketLinkData[];

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
          await this.db.ticketLink.update({
            where: { id: link.id },
            data: {
              prState: newPrState,
              prUpdatedAt: new Date(),
            },
          });
          updated++;
        }
      } catch (error) {
        if (error instanceof NotFoundAppException) {
          // 404: mark as closed
          await this.db.ticketLink.update({
            where: { id: link.id },
            data: {
              prState: 'closed',
              prUpdatedAt: new Date(),
            },
          });
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
      await this.db.$transaction(async (tx) => {
        // Validate the transition
        validateTransition(
          TicketStatus.IN_PROGRESS,
          TicketStatus.VERIFY_FIX,
          CommentType.FIX_REPORT,
        );

        // Update ticket status to VERIFY_FIX
        await tx.ticket.update({
          where: { id: link.ticketId },
          data: { status: TicketStatus.VERIFY_FIX },
        });

        // Create FIX_REPORT comment with PR details
        const mergeAuthor = prStatus.mergedBy ?? 'unknown';
        const mergeSha = prStatus.mergeSha ?? 'unknown';
        const commentBody = `Merged PR: ${prStatus.url} by ${mergeAuthor} (${mergeSha})`;

        await tx.comment.create({
          data: {
            ticketId: link.ticketId,
            body: commentBody,
            type: CommentType.FIX_REPORT,
            authorUserId: null,
            authorAgentId: 'system',
          },
        });

        // Log VCS_PR_MERGED activity
        // Store PR info in newValue field for activity display: "owner/repo#number by @author"
        const prInfo = `${link.externalRef || prStatus.url} by @${mergeAuthor}`;
        await tx.ticketActivity.create({
          data: {
            ticketId: link.ticketId,
            action: ActivityType.VCS_PR_MERGED,
            fromStatus: TicketStatus.IN_PROGRESS,
            toStatus: TicketStatus.VERIFY_FIX,
            actorUserId: null,
            actorAgentId: null,
            newValue: prInfo,
          },
        });
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

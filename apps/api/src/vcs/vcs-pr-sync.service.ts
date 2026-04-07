/**
 * VcsPrSyncService - Syncs PR status from VCS provider to TicketLink records
 */
import { Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Project, VcsConnection } from '@prisma/client';
import { decryptToken } from '../common/utils/encryption.util';
import { createVcsProvider } from './factory';
import { VcsPrStatus } from './types';

// PrismaClientLike from @nathapp/nestjs-prisma doesn't expose VCS models,
// but they exist at runtime. Define a delegate interface for proper typing.
interface TicketLinkDelegate {
  findMany(options: { where: Record<string, unknown> }): Promise<unknown[]>
  update(options: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>
}

interface ExtendedPrismaClient {
  ticketLink: TicketLinkDelegate
  [key: string]: unknown
}

/**
 * TicketLink data returned from findMany
 */
interface TicketLinkData {
  id: string
  prNumber: number | null
  prState: string | null
}

export interface SyncPrStatusResult {
  updated: number;
  skipped: number;
}

@Injectable()
export class VcsPrSyncService {
  constructor(private readonly prisma: PrismaService) {}

  private get db() {
    return this.prisma.client as unknown as ExtendedPrismaClient;
  }

  /**
   * Sync PR status from VCS provider to TicketLink records
   *
   * Queries TicketLink entries with active PRs (prNumber IS NOT NULL,
   * prState NOT IN ('merged', 'closed')), fetches current PR status from
   * the VCS provider, and updates TicketLink.prState and prUpdatedAt
   * when the state has changed.
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

    // Query TicketLink entries with active PRs
    const ticketLinks = (await this.db.ticketLink.findMany({
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
   * Maps VcsPrStatus to a prState string
   */
  private mapPrState(prStatus: VcsPrStatus): string {
    if (prStatus.merged) {
      return 'merged';
    }
    return prStatus.state;
  }
}
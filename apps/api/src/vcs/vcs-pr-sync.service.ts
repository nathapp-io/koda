/**
 * VcsPrSyncService - Stub for test compilation
 *
 * This stub allows tests to compile. The actual implementation will be added
 * by the implementer to make the tests pass.
 *
 * TODO: Implement syncPrStatus() method
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Project, VcsConnection } from '@prisma/client';
import { VcsPrStatus } from './types';

export interface SyncPrStatusResult {
  updated: number;
  skipped: number;
}

@Injectable()
export class VcsPrSyncService {
  constructor(private readonly prisma: PrismaService) {}

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
    // TODO: Implement this method
    // 1. Query TicketLink entries where prNumber IS NOT NULL AND prState NOT IN ('merged', 'closed')
    //    scoped to the given project via ticket relation
    // 2. For each TicketLink, call VCS provider.getPullRequestStatus(prNumber)
    // 3. If fetched state differs from stored, update TicketLink.prState and prUpdatedAt
    // 4. Handle errors per AC5/AC6
    // 5. Return { updated, skipped } counts
    throw new Error('Not implemented yet');
  }
}
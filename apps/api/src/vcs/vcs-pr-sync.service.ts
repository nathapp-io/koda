import { SystemWriter } from '../permissions/system-writer.decorator';
/**
 * VcsPrSyncService - Syncs PR status from VCS provider to TicketLink records
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import type { VcsConnectionDomain } from './domain/vcs.domain';
import { decryptToken } from '../common/utils/encryption.util';
import { providerForConnection } from './provider-for-connection';
import { VcsPrStatus } from './types';
import { TicketStatus, CommentType } from '../common/enums';
import { validateTransition } from '../tickets/state-machine/ticket-transitions';
import { VcsLinkExtractorService } from './vcs-link-extractor.service';
import type { VcsTicketDomain } from './domain/vcs.domain';
import { IVcsRepository, TicketLinkData, PrStateWriteResult, VCS_REPOSITORY } from './domain/vcs.repository';
import { VCS_CFG, IVcsConfig } from '../config/vcs.config';
import { mapPrState } from './pr-state';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { runAsSystemWriter } from '../action-context/action-context';
import { prStateSummary, type VcsPrStateAuditKey } from './vcs-audit';

export interface SyncPrStatusResult {
  updated: number;
  skipped: number;
}

/**
 * Permissions P2 US-004: the merge step's one key, on the link write and on the auto-transition.
 * `runAsSystemWriter` derives the `vcs` component from it, and the entry is the same whoever saw the
 * merge (the manual sync, the poller, the webhook or the fleet refresher).
 */
const MERGE_AUDIT_KEY = 'system.vcs.pr-merge-transition';

/** The auto-transition's entry summary: the status pair it wrote, never the PR or its author. */
const MERGE_TRANSITION_SUMMARY = `status: ${TicketStatus.IN_PROGRESS} -> ${TicketStatus.VERIFY_FIX}`;

@Injectable()
@SystemWriter(MERGE_AUDIT_KEY)
export class VcsPrSyncService {
  private readonly logger = new Logger(VcsPrSyncService.name);

  constructor(
    @Inject(VCS_REPOSITORY) private readonly vcsRepo: IVcsRepository,
    private readonly audit: AuditRecorder,
    @Optional() private readonly vcsLinkExtractorService?: VcsLinkExtractorService,
    @Optional() @Inject(VCS_CFG) private readonly vcsConfig?: IVcsConfig,
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
   * - prState is written first; the transition runs only for the writer that recorded the merge (D457)
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
    auditKey: VcsPrStateAuditKey,
  ): Promise<SyncPrStatusResult> {
    // Decrypt the token
    const decryptedToken = decryptToken(connection.encryptedToken, encryptionKey);

    // Create VCS provider
    const provider = providerForConnection(connection, decryptedToken, this.vcsConfig);

    // Query TicketLink entries with active PRs and their linked tickets
    const ticketLinks = await this.vcsRepo.findActiveTicketLinksWithPrs(project.id, connection);

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
        const newPrState = mapPrState(prStatus);

        // Update if state differs
        if (newPrState !== link.prState) {
          // merged/closed are terminal: an out-of-order or stale event must
          // never regress them (e.g. a delayed 'opened' event after a merge).
          const terminal = link.prState === 'merged' || link.prState === 'closed';
          if (!terminal) {
            const outcome = newPrState === 'merged'
              ? await this.applyMergedPr(link, prStatus)
              : await this.writePrState(link.id, newPrState, link.prState, project.id, auditKey);
            if (outcome === 'updated') {
              updated++;
            }

            // AC6: After syncPrStatus() updates a TicketLink, extractLinksFromPr() is called
            // to pick up new commits from the PR
            if (this.vcsLinkExtractorService && link.ticket && prStatus.branchName) {
              const ticketData = link.ticket;
              const ticketForExtraction: VcsTicketDomain = {
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
        }
      } catch (error) {
        if (error instanceof NotFoundAppException) {
          // 404: mark as closed. Keep a failed write isolated to this link.
          try {
            if ((await this.writePrState(link.id, 'closed', link.prState, project.id, auditKey)) === 'updated') {
              updated++;
            }
          } catch (writeError) {
            skipped++;
            this.logger.warn(`[vcs-pr-sync] Failed to close missing PR for link ${link.id}: ${writeError instanceof Error ? writeError.message : String(writeError)}`);
          }
        } else {
          // General API error: skip this PR
          skipped++;
        }
      }
    }

    return { updated, skipped };
  }

  private writePrState(
    linkId: string,
    nextState: string,
    previousState: string | null,
    projectId: string,
    auditKey: VcsPrStateAuditKey,
  ): Promise<PrStateWriteResult> {
    return this.audit.audited(
      () => this.vcsRepo.updateTicketLinkWithPrState(linkId, nextState),
      (outcome) => outcome === 'updated'
        ? { key: auditKey, resourceType: 'ticket-link', resourceId: linkId, projectId, summary: prStateSummary(previousState, nextState) }
        : [],
    );
  }

  /**
   * Fleet C9 §3.5 (D457): the one merge step for the VCS poll, the webhook and the fleet
   * PR-state refresher. The conditional write runs first; only the writer that moved the link
   * to `merged` transitions the ticket, so two paths that see one merge yield one VERIFY_FIX
   * and one FIX_REPORT comment. Transition failures are logged inside and never undo the write.
   *
   * Permissions P2 US-004: the step runs as `SYSTEM/vcs`, whatever context saw the merge, and each
   * write records its own entry in its own transaction — the link writes `pr <before> -> merged`, the
   * auto-transition writes `status: IN_PROGRESS -> VERIFY_FIX` on the ticket. `runAsSystem` keeps the
   * enclosing correlation id, so both entries still join the request or tick that saw the merge.
   */
  async applyMergedPr(link: TicketLinkData, prStatus: VcsPrStatus): Promise<PrStateWriteResult> {
    return runAsSystemWriter(this, async () => {
      const outcome = await this.audit.audited(
        () => this.vcsRepo.updateTicketLinkWithPrState(link.id, 'merged'),
        (result) => result === 'updated'
          ? {
            key: MERGE_AUDIT_KEY,
            resourceType: 'ticket-link',
            resourceId: link.id,
            projectId: link.ticket?.projectId ?? null,
            summary: prStateSummary(link.prState, 'merged'),
          }
          : [],
      );
      if (outcome === 'updated') await this.handleMergedPrAutoTransition(link, prStatus);
      return outcome;
    });
  }

  /**
   * Handle auto-transition when a PR is merged
   *
   * When a PR transitions to 'merged':
   * - If the linked ticket is IN_PROGRESS, transition it to VERIFY_FIX,
   *   create a FIX_REPORT comment, and log VCS_PR_MERGED activity
   * - If the ticket is not IN_PROGRESS, no transition is attempted
   *
   * Permissions P2 US-004: the transition, the FIX_REPORT comment and the VCS_PR_MERGED activity share
   * one transaction with the ticket's audit entry, so a rejected record rolls all three back.
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

      await this.audit.audited(
        () => this.vcsRepo.applyMergedPrTransition({
          ticketId: link.ticketId,
          externalRef: link.externalRef,
          prUrl: prStatus.url,
          mergedBy: prStatus.mergedBy ?? null,
          mergeSha: prStatus.mergeSha ?? null,
        }),
        () => ({
          key: MERGE_AUDIT_KEY,
          resourceType: 'ticket',
          resourceId: link.ticketId,
          projectId: link.ticket?.projectId ?? null,
          summary: MERGE_TRANSITION_SUMMARY,
        }),
      );
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
}

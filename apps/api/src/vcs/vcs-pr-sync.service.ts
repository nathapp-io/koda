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

/** Ephemeral provider results; never stored in an approval request. */
export type FetchedPrStatus = { link: TicketLinkData } & (
  { kind: 'status'; status: VcsPrStatus } | { kind: 'missing' } | { kind: 'error'; error: unknown }
);
export interface PrExtractionTarget {
  project: { id: string; key: string };
  ticket: VcsTicketDomain;
  connection: VcsConnectionDomain;
  encryptionKey: string;
  branchName: string;
  prNumber: number;
}
export interface ApplyPrStatusesResult extends SyncPrStatusResult {
  extractions: PrExtractionTarget[];
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
    const fetched = await this.fetchPrStatuses(project, connection, encryptionKey);
    const result = await this.applyPrStatuses(project, connection, encryptionKey, fetched, auditKey, { isolate: true });
    this.startExtractions(result.extractions);
    return { updated: result.updated, skipped: result.skipped };
  }

  async fetchPrStatuses(
    project: { id: string; key: string }, connection: VcsConnectionDomain, encryptionKey: string,
  ): Promise<FetchedPrStatus[]> {
    const provider = providerForConnection(connection, decryptToken(connection.encryptedToken, encryptionKey), this.vcsConfig);
    const links = await this.vcsRepo.findActiveTicketLinksWithPrs(project.id, connection);
    const fetched: FetchedPrStatus[] = [];
    for (const link of links) {
      if (link.prNumber == null) continue;
      try {
        fetched.push({ link, kind: 'status', status: await provider.getPullRequestStatus(link.prNumber) });
      } catch (error) {
        fetched.push(error instanceof NotFoundAppException ? { link, kind: 'missing' } : { link, kind: 'error', error });
      }
    }
    return fetched;
  }

  /** Strict apply runs inside the approval owner's transaction: no failure may be swallowed. */
  async applyPrStatuses(
    project: { id: string; key: string }, connection: VcsConnectionDomain, encryptionKey: string,
    fetched: FetchedPrStatus[], auditKey: VcsPrStateAuditKey, options: { isolate: boolean },
  ): Promise<ApplyPrStatusesResult> {
    let updated = 0;
    let skipped = 0;
    const extractions: PrExtractionTarget[] = [];
    for (const item of fetched) {
      const { link } = item;
      try {
        if (item.kind === 'error') throw item.error;
        if (item.kind === 'missing') {
          if (await this.writePrState(link.id, 'closed', project.id, auditKey, link.prState) === 'updated') updated++;
          continue;
        }
        const prStatus = item.status;
        const next = mapPrState(prStatus);
        if (next === link.prState || link.prState === 'merged' || link.prState === 'closed') continue;
        const outcome = next === 'merged'
          ? await this.applyMergedPr(link, prStatus, { rethrow: !options.isolate, expectedState: link.prState })
          : await this.writePrState(link.id, next, project.id, auditKey, link.prState);
        if (outcome !== 'updated') continue;
        updated++;
        if (link.ticket && prStatus.branchName) {
          extractions.push({
            project, connection, encryptionKey,
            ticket: { id: link.ticket.id, number: link.ticket.number, externalVcsId: link.ticket.externalVcsId },
            branchName: prStatus.branchName, prNumber: prStatus.number,
          });
        }
      } catch (error) {
        if (!options.isolate) throw error;
        skipped++;
        this.logger.warn(`[vcs-pr-sync] Failed to sync link ${link.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { updated, skipped, extractions };
  }

  /** Called only outside a deferred execution transaction. Failures remain warning-only. */
  startExtractions(targets: PrExtractionTarget[]): void {
    for (const target of targets) {
      this.vcsLinkExtractorService?.extractLinksFromPr(
        target.project, target.ticket, target.connection, target.encryptionKey, target.branchName, target.prNumber,
      ).catch((error: unknown) => {
        this.logger.warn(`[vcs-pr-sync] Failed to extract links for ticket ${target.ticket.id}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  /**
   * Review B1: the change is what the write actually replaced (`previousState`, read under the row
   * lock), never the caller's snapshot, so a state another writer already stored is not recorded
   * again and a change interleaved since the lookup is not missed.
   */
  private async writePrState(
    linkId: string,
    nextState: string,
    projectId: string,
    auditKey: VcsPrStateAuditKey,
    expectedState: string | null,
  ): Promise<PrStateWriteResult> {
    const outcome = await this.audit.audited(
      () => this.vcsRepo.updateTicketLinkWithPrState(linkId, nextState, { expectedState }),
      (written) => written.result === 'updated' && written.previousState !== nextState
        ? { key: auditKey, resourceType: 'ticket-link', resourceId: linkId, projectId, summary: prStateSummary(written.previousState, nextState) }
        : [],
    );
    return outcome.result;
  }

  /**
   * Fleet C9 §3.5 (D457): the one merge step for the VCS poll, the webhook and the fleet
   * PR-state refresher. The conditional write runs first; only the writer that moved the link
   * to `merged` transitions the ticket, so two paths that see one merge yield one VERIFY_FIX
   * and one FIX_REPORT comment. By default transition failures are logged without undoing the write;
   * deferred approval execution opts into rethrow so its owning transaction rolls everything back.
   *
   * Permissions P2 US-004: the step runs as `SYSTEM/vcs`, whatever context saw the merge, and each
   * write records its own entry in its own transaction — the link writes `pr <before> -> merged`, the
   * auto-transition writes `status: IN_PROGRESS -> VERIFY_FIX` on the ticket. `runAsSystem` keeps the
   * enclosing correlation id, so both entries still join the request or tick that saw the merge.
   */
  async applyMergedPr(link: TicketLinkData, prStatus: VcsPrStatus, options: { rethrow: boolean; expectedState?: string | null } = { rethrow: false }): Promise<PrStateWriteResult> {
    return runAsSystemWriter(this, async () => {
      const outcome = await this.audit.audited(
        () => options.expectedState === undefined
          ? this.vcsRepo.updateTicketLinkWithPrState(link.id, 'merged')
          : this.vcsRepo.updateTicketLinkWithPrState(link.id, 'merged', { expectedState: options.expectedState }),
        (written) => written.result === 'updated' && written.previousState !== 'merged'
          ? {
            key: MERGE_AUDIT_KEY,
            resourceType: 'ticket-link',
            resourceId: link.id,
            projectId: link.ticket?.projectId ?? null,
            summary: prStateSummary(written.previousState, 'merged'),
          }
          : [],
      );
      if (outcome.result === 'updated') await this.handleMergedPrAutoTransition(link, prStatus, options);
      return outcome.result;
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
   * By default failures are isolated; `{ rethrow: true }` propagates them to the transaction owner.
   */
  async handleMergedPrAutoTransition(
    link: TicketLinkData,
    prStatus: VcsPrStatus,
    options: { rethrow: boolean } = { rethrow: false },
  ): Promise<void> {
    // The snapshot is only a fast rejection; the repository's conditional update rechecks the
    // live ticket under its write lock before creating any transition records.
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
        (transitioned) => transitioned ? ({
          key: MERGE_AUDIT_KEY,
          resourceType: 'ticket',
          resourceId: link.ticketId,
          projectId: link.ticket?.projectId ?? null,
          summary: MERGE_TRANSITION_SUMMARY,
        }) : [],
      );
    } catch (error) {
      if (options.rethrow) throw error;
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

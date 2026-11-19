import { Inject, Injectable, Optional } from '@nestjs/common';
import type { VcsConnectionDomain } from './domain/vcs.domain';
import { VcsIssue } from './types';
import { providerForConnection } from './provider-for-connection';
import { decryptToken } from '../common/utils/encryption.util';
import { IVcsRepository, VCS_REPOSITORY } from './domain/vcs.repository';
import { externalVcsIdFor, VcsRepoRef } from './external-vcs-id';
import { VCS_CFG, IVcsConfig } from '../config/vcs.config';
import { AuditRecorder } from '../audit/audit-recorder.service';
import type { VcsIssueAuditKey } from './vcs-audit';

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

/**
 * Review-1119 US-006 (B1): the target an approved full import captured no longer matches, proven inside
 * an issue write's own transaction. It is a refusal, not a failed write: every remaining issue would be
 * refused the same way, so the pass stops instead of reporting one failure per fetched issue.
 */
export class VcsTargetDriftError extends Error {
  constructor(message = 'VCS connection or allowed authors changed after approval') {
    super(message);
    this.name = 'VcsTargetDriftError';
  }
}

/**
 * Revalidates the caller's captured import target. The repository runs it inside each issue write's
 * transaction, before that write, so the check and the write share one lock.
 */
export type VcsTargetRevalidation = () => Promise<void>;

export interface SyncIssuesOptions {
  isolate: boolean;
  /**
   * Review-1119 US-006 (B1): run before every issue write, inside its transaction. A deferred import
   * reaches its writes after the approval committed, so the target check that ran there holds no lock
   * any more; this one does.
   */
  revalidate?: VcsTargetRevalidation;
}

@Injectable()
export class VcsSyncService {
  constructor(
    @Inject(VCS_REPOSITORY) private readonly vcsRepo: IVcsRepository,
    private readonly audit: AuditRecorder,
    @Optional() @Inject(VCS_CFG) private readonly vcsConfig?: IVcsConfig,
  ) {}

  /**
   * Sync a single issue into a ticket.
   *
   * Permissions P2 US-002: `auditKey` is the entry point that ran this (a sync route, the poller or the
   * webhook intake), so an import's entry names where the outside write came from.
   *
   * Review-1119 US-006 (B1): `revalidate` proves the caller's captured target unchanged inside the
   * write's transaction; a throw from it writes nothing.
   */
  async syncIssue(
    project: { id: string },
    issue: VcsIssue,
    syncMode: 'manual' | 'polling' | 'webhook',
    repo: VcsRepoRef,
    auditKey: VcsIssueAuditKey,
    revalidate?: VcsTargetRevalidation,
  ): Promise<SyncIssueResult> {
    const externalVcsId = externalVcsIdFor(repo, issue.number);

    // Dedup includes soft-deleted tickets (M11): a deleted import stays deleted.
    const existingTicket = await this.vcsRepo.findExistingTicketByExternalId(project.id, externalVcsId);

    if (existingTicket) {
      return {
        action: 'skipped',
        reason: 'Ticket with this external VCS ID already exists',
      };
    }

    // Allocate ticket number in transaction and create ticket. The entry is recorded inside that
    // attempt's transaction through the callback: wrapping the call in `audited` would start an outer
    // transaction, and `runWithTicketNumberRetry` refuses to retry inside one.
    const result = await this.vcsRepo.createTicketFromIssue(project, issue, externalVcsId, async (ticket) => {
      await this.audit.record({
        key: auditKey,
        resourceType: 'ticket',
        resourceId: ticket.id,
        projectId: project.id,
        summary: `imported issue #${issue.number}`,
      });
    }, revalidate);

    // Review P2 remainder (US-003): another import of this issue won the race between the pre-check and
    // the insert. Outside a transaction that attempt is already rolled back, so this is a plain skip —
    // the same answer the pre-check gives. Inside an enclosing transaction the repository rethrows, so a
    // doomed transaction is never reported as a skip.
    if (!result) {
      return {
        action: 'skipped',
        reason: 'Ticket with this external VCS ID already exists',
      };
    }

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
   * Perform a full sync of all issues from the provider.
   *
   * The immediate manual sync. Review f-ee6758e4: a failed fetch propagates instead of being folded
   * into `errors`, which the caller discarded — that made a rejected GitLab issue continuation look
   * like a successful empty import, while the deferred path (`VcsManualSync.prepareSyncAll`) rejected
   * with the same failure. Individual issue writes stay best-effort (`isolate`), so their failures are
   * still listed in `errors` instead of aborting the batch (AC-29).
   */
  async fullSync(
    project: { id: string; key: string },
    connection: VcsConnectionDomain,
    encryptionKey: string,
  ): Promise<{
    issuesSynced: number;
    issuesSkipped: number;
    createdTickets: Array<{ id: string; number: number; title: string }>;
    errors: string[];
  }> {
    const decryptedToken = decryptToken(connection.encryptedToken, encryptionKey);
    const provider = providerForConnection(connection, decryptedToken, this.vcsConfig);
    const { issues } = await provider.fetchIssues();
    return this.syncIssues(project, this.filterByAllowedAuthors(issues, connection.allowedAuthors), connection, 'vcs.sync.all', { isolate: true });
  }

  /** Deferred callers propagate the first failure so the enclosing transaction rolls back. */
  async syncIssues(
    project: { id: string; key: string },
    issues: VcsIssue[],
    repo: VcsRepoRef,
    auditKey: VcsIssueAuditKey,
    { isolate, revalidate }: SyncIssuesOptions,
  ) {
    const createdTickets: Array<{ id: string; number: number; title: string }> = [];
    const errors: string[] = [];
    let issuesSynced = 0;
    let issuesSkipped = 0;
    for (const issue of issues) {
      try {
        const result = await this.syncIssue(project, issue, 'manual', repo, auditKey, revalidate);
        if (result.action === 'created') {
          issuesSynced++;
          if (result.ticketId && result.ticketNumber) {
            createdTickets.push({ id: result.ticketId, number: result.ticketNumber, title: result.ticketTitle ?? issue.title });
          }
        } else {
          issuesSkipped++;
        }
      } catch (error) {
        if (!isolate) throw error;
        if (error instanceof VcsTargetDriftError) {
          // Review-1119 US-006 (B1): the target is gone or changed. Each remaining write would be refused
          // the same way, so stop here and report the refusal once instead of once per fetched issue.
          errors.push(`import stopped: ${error.message}`);
          break;
        }
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        errors.push(`Issue ${issue.number}: ${errorMsg}`);
        issuesSkipped++;
      }
    }
    return { issuesSynced, issuesSkipped, createdTickets, errors };
  }
}

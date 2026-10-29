import { Injectable, Inject } from '@nestjs/common';
import { bookkeeping } from '../action-context/audit-coverage';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../generated/prisma/client';
import type { Ticket, VcsSyncLog, VcsConnection } from '../generated/prisma/client';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { VcsConnectionDomain, VcsConnectionWithProjectDomain, VcsSyncLogDomain, VcsProjectDomain, VcsTicketDomain } from './domain/vcs.domain';
import { ConnectionRepo, linkMatchesConnection } from './connection-pr-match';
import { runWithTicketNumberRetry } from '../common/utils/ticket-number-retry';
import { VcsIssue } from './types';
import { TicketStatus, CommentType, ActivityType } from '../common/enums';
import {
  CreateTicketFromIssueResult,
  CreateVcsConnectionData,
  CreateVcsSyncLogData,
  IVcsRepository,
  MergedPrTransitionInput,
  OutboxDedupQuery,
  OnTicketCreated,
  PrStateWriteOutcome,
  TicketLinkData,
  UpdateVcsConnectionData,
} from './domain/vcs.repository';

@Injectable()
export class PrismaVcsRepository implements IVcsRepository {
  constructor(
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly prisma: PrismaService<PrismaClient>,
  ) {}

  private get db() {
    return this.prisma.client;
  }

  // ---------------------------------------------------------------------------
  // Domain mappers
  // ---------------------------------------------------------------------------

  private toConnectionDomain(m: {
    id: string; projectId: string; provider: string; repoOwner: string; repoName: string;
    encryptedToken: string; syncMode: string; allowedAuthors: string; pollingIntervalMs: number;
    webhookSecret: string | null; isActive: boolean; lastSyncedAt: Date | null;
    createdAt: Date; updatedAt: Date;
  }): VcsConnectionDomain {
    return {
      id: m.id, projectId: m.projectId, provider: m.provider,
      repoOwner: m.repoOwner, repoName: m.repoName, encryptedToken: m.encryptedToken,
      syncMode: m.syncMode, allowedAuthors: m.allowedAuthors, pollingIntervalMs: m.pollingIntervalMs,
      webhookSecret: m.webhookSecret, isActive: m.isActive, lastSyncedAt: m.lastSyncedAt,
      createdAt: m.createdAt, updatedAt: m.updatedAt,
    };
  }

  private toProjectDomain(m: { id: string; key: string; slug: string }): VcsProjectDomain {
    return { id: m.id, key: m.key, slug: m.slug };
  }

  private toConnectionWithProjectDomain(m: {
    id: string; projectId: string; provider: string; repoOwner: string; repoName: string;
    encryptedToken: string; syncMode: string; allowedAuthors: string; pollingIntervalMs: number;
    webhookSecret: string | null; isActive: boolean; lastSyncedAt: Date | null;
    createdAt: Date; updatedAt: Date;
    project: { id: string; key: string; slug: string };
  }): VcsConnectionWithProjectDomain {
    return { ...this.toConnectionDomain(m), project: this.toProjectDomain(m.project) };
  }

  private toSyncLogDomain(m: VcsSyncLog): VcsSyncLogDomain {
    return {
      id: m.id, vcsConnectionId: m.vcsConnectionId, syncType: m.syncType,
      issuesSynced: m.issuesSynced, issuesSkipped: m.issuesSkipped,
      errorMessage: m.errorMessage, startedAt: m.startedAt,
      completedAt: m.completedAt,
    };
  }

  private toTicketDomain(t: Ticket): VcsTicketDomain {
    return { id: t.id, number: t.number, externalVcsId: t.externalVcsId };
  }

  // ---------------------------------------------------------------------------
  // Project
  // ---------------------------------------------------------------------------

  async findProjectById(projectId: string): Promise<{ id: string } | null> {
    return this.db.project.findUnique({ where: { id: projectId }, select: { id: true } });
  }

  // ---------------------------------------------------------------------------
  // VcsConnection
  // ---------------------------------------------------------------------------

  async findVcsConnectionByProjectId(projectId: string, options?: { lock: boolean }): Promise<VcsConnectionDomain | null> {
    if (options?.lock) {
      // The caller owns the transaction, keeping this lock through drift validation and all writes.
      if (!this.txManager.isInTransaction()) throw new Error('Connection locking requires an active transaction');
      const rows = await this.db.$queryRaw<VcsConnection[]>`
        SELECT * FROM "VcsConnection" WHERE "projectId" = ${projectId} FOR UPDATE
      `;
      return rows[0] ? this.toConnectionDomain(rows[0]) : null;
    }
    const m = await this.db.vcsConnection.findUnique({ where: { projectId } });
    return m ? this.toConnectionDomain(m) : null;
  }

  async findVcsConnectionById(connectionId: string): Promise<VcsConnectionWithProjectDomain | null> {
    const m = await this.db.vcsConnection.findUnique({
      where: { id: connectionId },
      include: { project: true },
    });
    return m ? this.toConnectionWithProjectDomain(m) : null;
  }

  async findVcsConnectionByProjectSlug(slug: string): Promise<VcsConnectionWithProjectDomain | null> {
    const m = await this.db.vcsConnection.findFirst({
      where: { project: { slug, deletedAt: null } },
      include: { project: true },
    });
    return m ? this.toConnectionWithProjectDomain(m) : null;
  }

  async findPollingConnections(): Promise<VcsConnectionWithProjectDomain[]> {
    const rows = await this.db.vcsConnection.findMany({
      where: { syncMode: 'polling', isActive: true },
      include: { project: true },
    });
    return rows.map((m) => this.toConnectionWithProjectDomain(m));
  }

  async createVcsConnection(data: CreateVcsConnectionData): Promise<VcsConnectionDomain> {
    return this.toConnectionDomain(await this.db.vcsConnection.create({ data }));
  }

  async updateVcsConnection(
    projectId: string,
    data: UpdateVcsConnectionData,
  ): Promise<VcsConnectionDomain> {
    return this.toConnectionDomain(await this.db.vcsConnection.update({ where: { projectId }, data }));
  }

  /** M10: the poll cursor, the newest issue update seen (never "now"). */
  async updateVcsConnectionLastSynced(connectionId: string, syncedAt: Date): Promise<void> {
    await this.db.vcsConnection.update({
      where: { id: connectionId },
      data: { lastSyncedAt: syncedAt },
    });
  }

  async deleteVcsConnection(projectId: string): Promise<void> {
    await this.db.vcsConnection.delete({ where: { projectId } });
  }

  // ---------------------------------------------------------------------------
  // VcsSyncLog
  // ---------------------------------------------------------------------------

  async createVcsSyncLog(data: CreateVcsSyncLogData): Promise<VcsSyncLogDomain> {
    return this.toSyncLogDomain(await this.db.vcsSyncLog.create({ data }));
  }

  // ---------------------------------------------------------------------------
  // Ticket + Issue
  // ---------------------------------------------------------------------------

  /**
   * Check whether a ticket with the given externalVcsId already exists in the project.
   * Includes soft-deleted tickets, so a deleted import is never re-imported (M11).
   */
  async findExistingTicketByExternalId(
    projectId: string,
    externalVcsId: string,
  ): Promise<VcsTicketDomain | null> {
    const ticket = await this.db.ticket.findFirst({
      where: { projectId, externalVcsId },
    });
    return ticket ? this.toTicketDomain(ticket) : null;
  }

  /**
   * Create a ticket from a VCS issue inside a transaction.
   * Allocates ticket number as MAX(number)+1 scoped to the project; retried on a concurrent-number conflict (M6).
   * `onCreated` runs inside the same attempt, after the insert, so a failure in it rolls the ticket back
   * and is not retried as a number conflict (Permissions P2 US-002).
   */
  async createTicketFromIssue(
    project: { id: string },
    issue: VcsIssue,
    externalVcsId: string,
    onCreated?: OnTicketCreated,
  ): Promise<CreateTicketFromIssueResult> {
    return runWithTicketNumberRetry(this.txManager, async () => {
      const lastTicket = await this.db.ticket.findFirst({
        where: { projectId: project.id },
        orderBy: { number: 'desc' },
      });

      const nextNumber = (lastTicket?.number ?? 0) + 1;

      const ticket = await this.db.ticket.create({
        data: {
          projectId: project.id,
          number: nextNumber,
          type: 'TASK',
          title: issue.title,
          description: issue.body,
          status: 'CREATED',
          priority: 'MEDIUM',
          externalVcsId,
          externalVcsUrl: issue.url,
          vcsSyncedAt: new Date(),
        },
      });

      if (onCreated) await onCreated({ id: ticket.id, number: ticket.number });

      return {
        id: ticket.id,
        number: ticket.number,
        title: ticket.title,
      };
    });
  }

  async findTicketWithProject(
    ticketId: string,
  ): Promise<{ id: string; number: number; externalVcsId: string | null; project: { id: string; key: string } } | null> {
    return this.db.ticket.findUnique({
      where: { id: ticketId },
      select: {
        id: true,
        number: true,
        externalVcsId: true,
        project: { select: { id: true, key: true } },
      },
    });
  }

  // ---------------------------------------------------------------------------
  // TicketLink
  // ---------------------------------------------------------------------------

  /**
   * Active PR links of the project that belong to the connection's repo (C9 §3.6, D458).
   * The DB narrows by project and state; the repo match runs here (plan P2: no LIKE wildcards).
   */
  async findActiveTicketLinksWithPrs(projectId: string, repo: ConnectionRepo): Promise<TicketLinkData[]> {
    const rows = (await this.db.ticketLink.findMany({
      include: {
        ticket: {
          select: {
            id: true,
            status: true,
            projectId: true,
            number: true,
            externalVcsId: true,
          },
        },
      },
      where: {
        prNumber: { not: null },
        prState: { notIn: ['merged', 'closed'] },
        ticket: { projectId, deletedAt: null },
      },
    })) as TicketLinkData[];
    return rows.filter((link) => linkMatchesConnection(link, repo));
  }

  /**
   * The project's link for PR `prNumber` of the connection's repo; webhook lookups (C9 §3.6, D458).
   * Oldest first, so the result is stable when a ticket pair links the same PR.
   */
  async findTicketLinkForConnectionPr(projectId: string, repo: ConnectionRepo, prNumber: number): Promise<TicketLinkData | null> {
    const rows = (await this.db.ticketLink.findMany({
      where: { prNumber, ticket: { projectId } },
      include: {
        ticket: {
          select: {
            id: true,
            status: true,
            projectId: true,
            number: true,
            externalVcsId: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    })) as TicketLinkData[];
    return rows.find((link) => linkMatchesConnection(link, repo)) ?? null;
  }

  /**
   * M12: the only TicketLink.prState write. A late or replayed event (fresh
   * delivery id, so replay protection lets it through) must not regress a merged
   * PR, so the write skips rows already `merged`.
   *
   * Review B1: the stored state is read under the row lock (`SELECT … FOR UPDATE`) in the same
   * transaction as the write, so `previousState` is the state this write really replaced instead of
   * a snapshot taken before the transaction. Two writers that both read `open` cannot both report a
   * change, and a change another writer interleaved between the caller's lookup and this write is
   * not lost. `count === 0` used to be ambiguous (already merged vs deleted); the locked read answers
   * it, so a vanished link is never reported as already merged.
   */
  async updateTicketLinkWithPrState(id: string, prState: string, options?: { expectedState: string | null }): Promise<PrStateWriteOutcome> {
    return this.txManager.run(async () => {
      const rows = await this.db.$queryRaw<Array<{ prState: string | null }>>`
        SELECT "prState" FROM "TicketLink" WHERE "id" = ${id} FOR UPDATE`;
      if (rows.length === 0) return { result: 'not-found' as const, previousState: null };

      const previousState = rows[0].prState;
      if (previousState === 'merged') return { result: 'already-merged' as const, previousState };
      if (options && previousState !== options.expectedState) return { result: 'state-changed' as const, previousState };

      const write = () => this.db.ticketLink.update({ where: { id }, data: { prState, prUpdatedAt: new Date() } });
      if (previousState === prState) await bookkeeping('vcs.pr-same-state', write);
      else await write();
      return { result: 'updated' as const, previousState };
    });
  }

  /**
   * Perform the merged-PR auto-transition inside a transaction:
   * - Update ticket status to VERIFY_FIX
   * - Create a FIX_REPORT comment
   * - Log a VCS_PR_MERGED activity
   */
  async applyMergedPrTransition(input: MergedPrTransitionInput): Promise<boolean> {
    return this.txManager.run(async () => {
      // The conditional update takes the ticket row lock and rechecks eligibility against the
      // current version, not the ticket snapshot from before provider fetching.
      const changed = await this.db.ticket.updateMany({
        where: { id: input.ticketId, status: TicketStatus.IN_PROGRESS, deletedAt: null },
        data: { status: TicketStatus.VERIFY_FIX },
      });
      if (changed.count === 0) return false;

      const mergeAuthor = input.mergedBy ?? 'unknown';
      const mergeSha = input.mergeSha ?? 'unknown';
      const commentBody = `Merged PR: ${input.prUrl} by ${mergeAuthor} (${mergeSha})`;

      await this.db.comment.create({
        data: {
          ticketId: input.ticketId,
          body: commentBody,
          type: CommentType.FIX_REPORT,
          authorUserId: null,
          authorAgentId: null,
        },
      });

      const prInfo = `${input.externalRef || input.prUrl} by @${mergeAuthor}`;
      await this.db.ticketActivity.create({
        data: {
          ticketId: input.ticketId,
          action: ActivityType.VCS_PR_MERGED,
          fromStatus: TicketStatus.IN_PROGRESS,
          toStatus: TicketStatus.VERIFY_FIX,
          actorUserId: null,
          actorAgentId: null,
          newValue: prInfo,
        },
      });
      return true;
    });
  }

  // ---------------------------------------------------------------------------
  // TicketLink upsert (used by VcsLinkExtractorService)
  // ---------------------------------------------------------------------------

  /**
   * Insert the link, or refresh the one already stored for (ticketId, url).
   * Answers the created link's id, or `null` when a link existed and only the
   * update branch ran: the extractor audits exactly the creation (Permissions P2 US-005).
   */
  async upsertTicketLink(
    ticketId: string,
    url: string,
    provider: string,
    linkType: string,
    externalRef?: string,
    createdAt?: Date,
  ): Promise<string | null> {
    const existing = await this.db.ticketLink.findFirst({ where: { ticketId, url } });

    if (existing) {
      await bookkeeping('vcs.link-refresh', () => this.db.ticketLink.upsert({
        where: { ticketId_url: { ticketId, url } },
        create: {
          ticketId,
          url,
          provider,
          linkType,
          externalRef: externalRef ?? null,
          ...(createdAt ? { createdAt } : {}),
        },
        update: {
          linkType,
          externalRef: externalRef ?? null,
        },
      }));
      return null;
    }

    const created = await this.db.ticketLink.create({
      data: {
        ticketId,
        url,
        provider,
        linkType,
        externalRef: externalRef ?? null,
        ...(createdAt ? { createdAt } : {}),
      },
      select: { id: true },
    });
    return created.id;
  }

  // ---------------------------------------------------------------------------
  // Outbox dedup (cross-instance push deduplication)
  // ---------------------------------------------------------------------------

  async findPendingOutboxEvents(query: OutboxDedupQuery): Promise<{ id: string }[]> {
    return this.db.outboxEvent.findMany({
      where: {
        projectId: query.projectId,
        type: query.eventType,
        eventId: query.eventId,
        status: { in: query.statuses },
        createdAt: { gte: query.since },
      },
      select: { id: true },
      take: 1,
    });
  }
}

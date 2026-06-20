import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import type { Ticket, VcsSyncLog } from '@prisma/client';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { VcsConnectionDomain, VcsConnectionWithProjectDomain, VcsSyncLogDomain, VcsProjectDomain } from './domain/vcs.domain';
import { VcsIssue } from './types';
import { TicketStatus, CommentType, ActivityType } from '../common/enums';
import {
  CreateTicketFromIssueResult,
  CreateVcsConnectionData,
  CreateVcsSyncLogData,
  IVcsRepository,
  MergedPrTransitionInput,
  OutboxDedupQuery,
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

  // ---------------------------------------------------------------------------
  // Project
  // ---------------------------------------------------------------------------

  async findProjectById(projectId: string): Promise<{ id: string } | null> {
    return this.db.project.findUnique({ where: { id: projectId }, select: { id: true } });
  }

  // ---------------------------------------------------------------------------
  // VcsConnection
  // ---------------------------------------------------------------------------

  async findVcsConnectionByProjectId(projectId: string): Promise<VcsConnectionDomain | null> {
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

  async updateVcsConnectionLastSynced(connectionId: string): Promise<void> {
    await this.db.vcsConnection.update({
      where: { id: connectionId },
      data: { lastSyncedAt: new Date() },
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
   * Includes soft-deleted tickets to prevent duplicate number allocation.
   */
  async findExistingTicketByExternalId(
    projectId: string,
    externalVcsId: string,
  ): Promise<Ticket | null> {
    return this.db.ticket.findFirst({
      where: { projectId, externalVcsId, deletedAt: null },
    });
  }

  /**
   * Create a ticket from a VCS issue inside a transaction.
   * Allocates ticket number as MAX(number)+1 scoped to the project.
   */
  async createTicketFromIssue(
    project: { id: string },
    issue: VcsIssue,
  ): Promise<CreateTicketFromIssueResult> {
    return this.txManager.run(async () => {
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
          externalVcsId: `${issue.number}`,
          externalVcsUrl: issue.url,
          vcsSyncedAt: new Date(),
        },
      });

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
   * Query TicketLink entries with active PRs for a project.
   */
  async findActiveTicketLinksWithPrs(projectId: string): Promise<TicketLinkData[]> {
    return this.db.ticketLink.findMany({
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
    }) as Promise<TicketLinkData[]>;
  }

  /**
   * Find a TicketLink by project ID and PR number.
   * Used by webhook handlers.
   */
  async findTicketLinkByPrNumber(
    projectId: string,
    prNumber: number,
  ): Promise<TicketLinkData | null> {
    return this.db.ticketLink.findFirst({
      where: {
        prNumber,
        ticket: { projectId },
      },
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
    }) as Promise<TicketLinkData | null>;
  }

  /**
   * Update a TicketLink's prState and prUpdatedAt.
   */
  async updateTicketLinkPrState(id: string, prState: string): Promise<void> {
    await this.db.ticketLink.update({
      where: { id },
      data: { prState, prUpdatedAt: new Date() },
    });
  }

  /**
   * Update a TicketLink's prState and prUpdatedAt (alias for webhook service).
   */
  async updateTicketLinkWithPrState(id: string, prState: string): Promise<void> {
    await this.updateTicketLinkPrState(id, prState);
  }

  /**
   * Perform the merged-PR auto-transition inside a transaction:
   * - Update ticket status to VERIFY_FIX
   * - Create a FIX_REPORT comment
   * - Log a VCS_PR_MERGED activity
   */
  async applyMergedPrTransition(input: MergedPrTransitionInput): Promise<void> {
    await this.txManager.run(async () => {
      await this.db.ticket.update({
        where: { id: input.ticketId },
        data: { status: TicketStatus.VERIFY_FIX },
      });

      const mergeAuthor = input.mergedBy ?? 'unknown';
      const mergeSha = input.mergeSha ?? 'unknown';
      const commentBody = `Merged PR: ${input.prUrl} by ${mergeAuthor} (${mergeSha})`;

      await this.db.comment.create({
        data: {
          ticketId: input.ticketId,
          body: commentBody,
          type: CommentType.FIX_REPORT,
          authorUserId: null,
          authorAgentId: 'system',
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
    });
  }

  // ---------------------------------------------------------------------------
  // TicketLink upsert (used by VcsLinkExtractorService)
  // ---------------------------------------------------------------------------

  async upsertTicketLink(
    ticketId: string,
    url: string,
    provider: string,
    linkType: string,
    externalRef?: string,
    createdAt?: Date,
  ): Promise<void> {
    const existing = await this.db.ticketLink.findFirst({ where: { ticketId, url } });

    if (existing) {
      await this.db.ticketLink.upsert({
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
      });
    } else {
      await this.db.ticketLink.create({
        data: {
          ticketId,
          url,
          provider,
          linkType,
          externalRef: externalRef ?? null,
          ...(createdAt ? { createdAt } : {}),
        },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Outbox dedup (cross-instance push deduplication)
  // ---------------------------------------------------------------------------

  async findPendingOutboxEvents(query: OutboxDedupQuery): Promise<{ id: string }[]> {
    return this.db.outboxEvent.findMany({
      where: {
        projectId: query.projectId,
        eventType: query.eventType,
        eventId: query.eventId,
        status: { in: query.statuses },
        createdAt: { gte: query.since },
      },
      select: { id: true },
      take: 1,
    });
  }
}

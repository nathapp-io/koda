import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { Ticket } from '@prisma/client';
import { Project } from '@prisma/client';
import { VcsIssue } from './types';
import { TicketStatus, CommentType, ActivityType } from '../common/enums';
import { IVcsRepository } from './domain/vcs.repository';

/**
 * Data needed for the merged-PR auto-transition
 */
export interface MergedPrTransitionInput {
  ticketId: string;
  externalRef: string | null;
  prUrl: string;
  mergedBy: string | null;
  mergeSha: string | null;
}

/**
 * Result of creating a ticket from a VCS issue
 */
export interface CreateTicketFromIssueResult {
  id: string;
  number: number;
  title: string;
}

@Injectable()
export class PrismaVcsRepository implements IVcsRepository {
  constructor(
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly prisma: PrismaService<PrismaClient>,
  ) {}

  private get db() {
    return this.prisma.client;
  }

  /**
   * Check whether a ticket with the given externalVcsId already exists in the project.
   * Includes soft-deleted tickets to prevent duplicate number allocation.
   */
  async findExistingTicketByExternalId(projectId: string, externalVcsId: string): Promise<Ticket | null> {
    return this.db.ticket.findFirst({
      where: {
        projectId,
        externalVcsId,
        deletedAt: null,
      },
    });
  }

  /**
   * Create a ticket from a VCS issue inside a transaction.
   * Allocates ticket number as MAX(number)+1 scoped to the project.
   */
  async createTicketFromIssue(project: Project, issue: VcsIssue): Promise<CreateTicketFromIssueResult> {
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

  /**
   * Query TicketLink entries with active PRs for a project.
   */
  async findActiveTicketLinksWithPrs(projectId: string) {
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
        ticket: {
          projectId,
          deletedAt: null,
        },
      },
    });
  }

  /**
   * Update a TicketLink's prState and prUpdatedAt.
   */
  async updateTicketLinkPrState(id: string, prState: string): Promise<void> {
    await this.db.ticketLink.update({
      where: { id },
      data: {
        prState,
        prUpdatedAt: new Date(),
      },
    });
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
}

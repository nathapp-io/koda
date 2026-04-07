import { Injectable, Optional, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import {
  Ticket,
  Comment,
  TicketActivity,
  PrismaClient,
} from '@prisma/client';
import { TicketStatus, CommentType, ActivityType } from '../../common/enums';
import { validateTransition } from './ticket-transitions';
import { RagService } from '../../rag/rag.service';
import { WebhookDispatcherService } from '../../webhook/webhook-dispatcher.service';
import { VcsConnectionService } from '../../vcs/vcs-connection.service';
import { buildBranchName } from '../../vcs/branch-name.util';
import { createVcsProvider, VcsProviderConfig } from '../../vcs/factory';
import { VcsLinkExtractorService } from '../../vcs/vcs-link-extractor.service';
import { decryptToken } from '../../common/utils/encryption.util';
import { TicketLinksService } from '../../ticket-links/ticket-links.service';
import { IVcsProvider, VcsPullRequest } from '../../vcs';

export interface CurrentUser {
  id: string;
  sub: string;
}

export interface TransitionResultWithComment {
  ticket: Ticket;
  comment: Comment;
  activity: TicketActivity;
}

export interface TransitionResultWithoutComment {
  ticket: Ticket;
  activity: TicketActivity;
}

export type TransitionResult = TransitionResultWithComment | TransitionResultWithoutComment;

@Injectable()
export class TicketTransitionsService {
  private readonly logger = new Logger(TicketTransitionsService.name);

  constructor(
    private readonly prisma: PrismaService<PrismaClient>,
    @Optional() private readonly ragService?: RagService,
    @Optional() private readonly webhookDispatcher?: WebhookDispatcherService,
    @Optional() private readonly vcsConnectionService?: VcsConnectionService,
    @Optional() private readonly ticketLinksService?: TicketLinksService,
    @Optional() private readonly vcsLinkExtractorService?: VcsLinkExtractorService,
    @Optional() private readonly configService?: ConfigService,
  ) {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get db() { return this.prisma.client; }

  /**
   * Fire-and-forget: dispatch STATUS_CHANGE webhook for a ticket.
   */
  private dispatchStatusChangeWebhook(
    projectId: string,
    ticket: Ticket,
    fromStatus: string,
    toStatus: string,
  ): void {
    if (!this.webhookDispatcher) return;

    const dispatcher = this.webhookDispatcher;
    dispatcher
      .dispatch(projectId, 'STATUS_CHANGE', {
        event: 'STATUS_CHANGE',
        timestamp: new Date().toISOString(),
        ticket: { id: ticket.id, ref: ticket.id, status: toStatus },
        from: fromStatus,
        to: toStatus,
      })
      .catch(() => {
        // suppress webhook errors — transition must always succeed
      });
  }

  /**
   * Fire-and-forget: index a closed ticket in the RAG knowledge base.
   * Only runs when project.autoIndexOnClose is true and RagService is available.
   */
  private autoIndexTicket(
    project: { id: string; key: string; autoIndexOnClose: boolean },
    ticket: Ticket,
  ): void {
    if (!this.ragService || !project.autoIndexOnClose) return;

    const ragService = this.ragService;
    const projectId = project.id;

    this.db.ticket
      .findUnique({ where: { id: ticket.id }, include: { comments: true } })
      .then((ticketFull) => {
        if (!ticketFull) return;
        const content = [
          `Title: ${ticketFull.title}`,
          `Type: ${ticketFull.type}`,
          `Description: ${ticketFull.description ?? ''}`,
          ...ticketFull.comments.map((c) => `[${c.type}] ${c.body}`),
        ].join('\n\n');
        return ragService.indexDocument(projectId, {
          source: 'ticket',
          sourceId: ticketFull.id,
          content,
          metadata: {
            ref: `${project.key}-${ticketFull.number}`,
            type: ticketFull.type,
            status: 'CLOSED',
          },
        });
      })
      .catch(() => {
        // suppress RAG indexing errors — ticket close must always succeed
      });
  }

  /**
   * Fire-and-forget: create a GitHub PR when ticket transitions to VERIFIED.
   * Only runs when VCS connection exists and VcsConnectionService/TicketLinksService are available.
   */
  private createPrForTicket(
    project: { id: string; key: string },
    ticket: Ticket,
  ): Promise<void> {
    if (!this.vcsConnectionService || !this.ticketLinksService || !this.vcsLinkExtractorService || !this.configService) return Promise.resolve();

    const vcsService = this.vcsConnectionService;
    const vcsLinkExtractor = this.vcsLinkExtractorService;
    const encryptionKey = this.configService.get<string>('vcs.encryptionKey');
    if (!encryptionKey) return Promise.resolve();

    const projectId = project.id;
    const ticketId = ticket.id;
    const projectKey = project.key;

    return vcsService.getFullByProject(projectId)
      .then((connection): Promise<void> => {
        if (!connection.isActive) return Promise.resolve();

        const token = decryptToken(connection.encryptedToken, encryptionKey);
        const repoUrl = `https://github.com/${connection.repoOwner}/${connection.repoName}`;
        const provider = createVcsProvider(connection.provider, {
          provider: connection.provider,
          token,
          repoUrl,
        });

        return provider.getDefaultBranch().then((baseBranch): Promise<void> => {
          const branchName = buildBranchName(projectKey, ticket.number, ticket.title);
          const prTitle = `${projectKey}-${ticket.number}: ${ticket.title}`;
          const prBody = ticket.description ?? '';

          return this.db.ticketLink.create({
            data: {
              ticketId,
              url: `https://github.com/${connection.repoOwner}/${connection.repoName}/pulls/pending`,
              provider: 'github',
              externalRef: `${connection.repoOwner}/${connection.repoName}#pending`,
            },
          }).then((link): Promise<void> => {
            return provider.createPullRequest({
              title: prTitle,
              body: prBody,
              headBranch: branchName,
              baseBranch,
              draft: true,
            }).then((pr): Promise<void> => {
              return this.db.ticketLink.update({
                where: { id: link.id },
                data: {
                  url: pr.url,
                  externalRef: `${connection.repoOwner}/${connection.repoName}#${pr.number}`,
                  prNumber: pr.number,
                  prState: 'draft',
                  prUpdatedAt: new Date(),
                },
              }) as unknown as Promise<void>;
            });
          }).then((): Promise<void> => {
            return this.db.ticketActivity.create({
              data: {
                ticketId,
                action: ActivityType.VCS_PR_CREATED,
              },
            }) as unknown as Promise<void>;
          }).then((): Promise<void> => {
            // AC5: After createPrForTicket() completes, extractLinksFromPr() is called
            return vcsLinkExtractor.extractLinksFromPr(
              project,
              ticket,
              connection,
              encryptionKey,
              branchName,
            );
          }).catch((err) => {
            this.logger.warn(
              `[vcs] Failed to create PR for ticket ${projectKey}-${ticket.number}: ${err instanceof Error ? err.message : String(err)}`,
            );
            return Promise.resolve();
          });
        });
      })
      .catch(() => {
        // suppress VCS errors — ticket transition must always succeed
        return Promise.resolve();
      });
  }


  /**
   * Transition CREATED → VERIFIED, or VERIFY_FIX → CLOSED (if ticket is already in VERIFY_FIX)
   */
  async verify(
    projectSlug: string,
    ticketRef: string,
    commentBody: string,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ): Promise<TransitionResultWithComment> {
    const ticket = await this.findTicketByRef(projectSlug, ticketRef);
    if (ticket?.status === TicketStatus.VERIFY_FIX) {
      return this.executeTransition(
        projectSlug,
        ticketRef,
        TicketStatus.CLOSED,
        CommentType.REVIEW,
        commentBody ?? 'Verified',
        currentUser,
        actorType,
      ) as Promise<TransitionResultWithComment>;
    }
    return this.executeTransition(
      projectSlug,
      ticketRef,
      TicketStatus.VERIFIED,
      CommentType.VERIFICATION,
      commentBody ?? 'Verified',
      currentUser,
      actorType,
    ) as Promise<TransitionResultWithComment>;
  }

  /**
   * Transition VERIFIED → IN_PROGRESS (no comment required)
   */
  async start(
    projectSlug: string,
    ticketRef: string,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ): Promise<TransitionResultWithoutComment> {
    return this.executeTransition(
      projectSlug,
      ticketRef,
      TicketStatus.IN_PROGRESS,
      undefined,
      undefined,
      currentUser,
      actorType,
    ) as Promise<TransitionResultWithoutComment>;
  }

  /**
   * Transition IN_PROGRESS → VERIFY_FIX
   */
  async fix(
    projectSlug: string,
    ticketRef: string,
    commentBody: string,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ): Promise<TransitionResultWithComment> {
    return this.executeTransition(
      projectSlug,
      ticketRef,
      TicketStatus.VERIFY_FIX,
      CommentType.FIX_REPORT,
      commentBody ?? 'Fix submitted',
      currentUser,
      actorType,
    ) as Promise<TransitionResultWithComment>;
  }

  /**
   * Transition VERIFY_FIX → CLOSED (approve=true) or IN_PROGRESS (approve=false)
   */
  async verifyFix(
    projectSlug: string,
    ticketRef: string,
    commentBody: string,
    approve: boolean,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ): Promise<TransitionResultWithComment> {
    // verify-fix is only valid when ticket is in VERIFY_FIX status
    const ticket = await this.findTicketByRef(projectSlug, ticketRef);
    if (!ticket) throw new NotFoundAppException();
    if (ticket.status !== TicketStatus.VERIFY_FIX) {
      throw new ValidationAppException({}, 'tickets');
    }
    const toStatus = approve ? TicketStatus.CLOSED : TicketStatus.IN_PROGRESS;
    return this.executeTransition(
      projectSlug,
      ticketRef,
      toStatus,
      CommentType.REVIEW,
      commentBody,
      currentUser,
      actorType,
    ) as Promise<TransitionResultWithComment>;
  }

  /**
   * Transition to CLOSED from any valid status (no comment required)
   * Bypasses normal transition rules to allow closing from multiple states
   */
  async close(
    projectSlug: string,
    ticketRef: string,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ): Promise<TransitionResultWithoutComment> {
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });
    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'tickets');
    }

    const ticket = await this.findTicketByRef(projectSlug, ticketRef);
    if (!ticket) {
      throw new NotFoundAppException({}, 'tickets');
    }

    // Validate that CLOSED is reachable from current status
    if (
      ticket.status === TicketStatus.CLOSED ||
      ticket.status === TicketStatus.CREATED ||
      ticket.status === TicketStatus.REJECTED
    ) {
      throw new ValidationAppException({}, 'tickets');  // i18n key for invalid ticket transition
    }

    // Execute transition without comment requirement
    const transaction = await this.db.$transaction(async (tx) => {
      const actorUserId = actorType === 'user' ? currentUser.sub : null;
      const actorAgentId = actorType === 'agent' ? currentUser.sub : null;

      // Update ticket status
      const updatedTicket = await tx.ticket.update({
        where: { id: ticket.id },
        data: { status: TicketStatus.CLOSED },
      });

      // Create activity record
      const activity = await tx.ticketActivity.create({
        data: {
          ticketId: ticket.id,
          action: ActivityType.STATUS_CHANGE,
          fromStatus: ticket.status,
          toStatus: TicketStatus.CLOSED,
          actorUserId,
          actorAgentId,
        },
      });

      return {
        ticket: updatedTicket,
        activity,
      };
    });

    this.autoIndexTicket(project, transaction.ticket);
    this.dispatchStatusChangeWebhook(project.id, transaction.ticket, ticket.status, TicketStatus.CLOSED);

    return transaction;
  }

  /**
   * Transition CREATED or VERIFIED → REJECTED
   */
  async reject(
    projectSlug: string,
    ticketRef: string,
    commentBody: string,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ): Promise<TransitionResultWithComment> {
    return this.executeTransition(
      projectSlug,
      ticketRef,
      TicketStatus.REJECTED,
      CommentType.GENERAL,
      commentBody,
      currentUser,
      actorType,
    ) as Promise<TransitionResultWithComment>;
  }

  /**
   * Core transition execution logic with validation and transaction handling
   */
  private async executeTransition(
    projectSlug: string,
    ticketRef: string,
    toStatus: TicketStatus,
    commentType: CommentType | undefined,
    commentBody: string | undefined,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ): Promise<TransitionResult> {
    // Find project
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });
    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'tickets');
    }

    // Find ticket
    const ticket = await this.findTicketByRef(projectSlug, ticketRef);
    if (!ticket) {
      throw new NotFoundAppException({}, 'tickets');
    }

    // Validate transition (ticket.status is String in SQLite schema, cast to local enum type)
    validateTransition(ticket.status as TicketStatus, toStatus, commentType);

    // Execute transition in transaction
    return this.db.$transaction(async (tx) => {
      const actorUserId = actorType === 'user' ? currentUser.sub : null;
      const actorAgentId = actorType === 'agent' ? currentUser.sub : null;

      // Create comment if needed
      let comment = null;
      if (commentType && commentBody) {
        comment = await tx.comment.create({
          data: {
            ticketId: ticket.id,
            body: commentBody,
            type: commentType,
            authorUserId: actorUserId,
            authorAgentId: actorAgentId,
          },
        });
      }

      // Update ticket status
      const updatedTicket = await tx.ticket.update({
        where: { id: ticket.id },
        data: { status: toStatus },
      });

      // Create activity record
      const activity = await tx.ticketActivity.create({
        data: {
          ticketId: ticket.id,
          action: ActivityType.STATUS_CHANGE,
          fromStatus: ticket.status,
          toStatus,
          actorUserId,
          actorAgentId,
        },
      });

      if (comment) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return {
          ticket: updatedTicket,
          comment,
          activity,
        } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return {
        ticket: updatedTicket,
        activity,
      } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    }).then(async (result: TransitionResult) => {
      // Auto-index when a ticket transitions to CLOSED via normal state machine
      if (toStatus === TicketStatus.CLOSED) {
        this.autoIndexTicket(project, result.ticket);
      }
      // Dispatch webhook for status change
      this.dispatchStatusChangeWebhook(project.id, result.ticket, ticket.status, toStatus);
      // Auto-create PR when ticket transitions to VERIFIED
      if (toStatus === TicketStatus.VERIFIED) {
        await this.createPrForTicket(project, result.ticket);
      }
      return result;
    });
  }

  /**
   * Helper to find ticket by ref (supports both KODA-1 format and CUID)
   */
  private async findTicketByRef(projectSlug: string, ref: string) {
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project) {
      return null;
    }

    // Try KODA-42 format first
    const refPattern = /^([A-Z]+)-(\d+)$/;
    const match = ref.match(refPattern);

    if (match) {
      const number = parseInt(match[2], 10);
      return this.db.ticket.findUnique({
        where: {
          projectId_number: {
            projectId: project.id,
            number,
          },
        },
      });
    }

    // Try as CUID
    return this.db.ticket.findUnique({
      where: { id: ref },
    });
  }
}

import { Injectable, Optional, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import type {
  Ticket,
  Comment,
  TicketActivity,
} from '@prisma/client';
import { TicketStatus, CommentType, ActivityType } from '../../common/enums';
import { validateTransition } from './ticket-transitions';
import { RagService } from '../../rag/rag.service';
import { WebhookDispatcherService } from '../../webhook/webhook-dispatcher.service';
import { VcsConnectionService } from '../../vcs/vcs-connection.service';
import { buildBranchName } from '../../vcs/branch-name.util';
import { createVcsProvider } from '../../vcs/factory';
import { VcsLinkExtractorService } from '../../vcs/vcs-link-extractor.service';
import { decryptToken } from '../../common/utils/encryption.util';
import { TicketLinksService } from '../../ticket-links/ticket-links.service';
import { IVcsProvider, VcsPullRequest } from '../../vcs';
import { actorForeignKeys } from '../../auth/principal/actor-foreign-keys';
import { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { TICKET_REPOSITORY, ITicketRepository } from '../domain/ticket.domain';
import type { TicketDomain } from '../domain/ticket.domain';

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
    @Inject(TICKET_REPOSITORY) private readonly ticketRepo: ITicketRepository,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Optional() private readonly ragService?: RagService,
    @Optional() private readonly webhookDispatcher?: WebhookDispatcherService,
    @Optional() private readonly vcsConnectionService?: VcsConnectionService,
    @Optional() private readonly ticketLinksService?: TicketLinksService,
    @Optional() private readonly vcsLinkExtractorService?: VcsLinkExtractorService,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  /**
   * Fire-and-forget: dispatch STATUS_CHANGE webhook for a ticket.
   */
  private dispatchStatusChangeWebhook(
    projectId: string,
    ticket: TicketDomain,
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
    ticket: TicketDomain,
  ): void {
    if (!this.ragService || !project.autoIndexOnClose) return;

    const ragService = this.ragService;
    const projectId = project.id;

    (this.ticketRepo as import('../prisma-tickets.repository').PrismaTicketsRepository)
      .findTicketWithComments(ticket.id)
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
    ticket: TicketDomain,
  ): Promise<void> {
    if (!this.vcsConnectionService || !this.ticketLinksService || !this.vcsLinkExtractorService || !this.configService) return Promise.resolve();

    const vcsService = this.vcsConnectionService;
    const vcsLinkExtractor = this.vcsLinkExtractorService;
    const encryptionKey = this.configService.get<string>('vcs.encryptionKey');
    if (!encryptionKey) return Promise.resolve();

    const projectId = project.id;
    const ticketId = ticket.id;
    const projectKey = project.key;
    const repo = this.ticketRepo as import('../prisma-tickets.repository').PrismaTicketsRepository;

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

          return repo.createTicketLink({
            ticketId,
            url: `https://github.com/${connection.repoOwner}/${connection.repoName}/pulls/pending`,
            provider: 'github',
            externalRef: `${connection.repoOwner}/${connection.repoName}#pending`,
            linkType: 'pr',
          }).then((link): Promise<void> => {
            return provider.createPullRequest({
              title: prTitle,
              body: prBody,
              branchName,
              baseBranch,
              draft: true,
            }).then((pr): Promise<void> => {
              return repo.updateTicketLink(link.id, {
                url: pr.url,
                externalRef: `${connection.repoOwner}/${connection.repoName}#${pr.number}`,
                prNumber: pr.number,
                prState: 'draft',
                prUpdatedAt: new Date(),
                linkType: 'pr',
              }) as unknown as Promise<void>;
            });
          }).then((): Promise<void> => {
            return repo.createTicketActivity({
              ticketId,
              action: ActivityType.VCS_PR_CREATED,
            }) as unknown as Promise<void>;
          }).then((): Promise<void> => {
            // AC5: After createPrForTicket() completes, extractLinksFromPr() is called
            return vcsLinkExtractor.extractLinksFromPr(
              project,
              ticket as unknown as Ticket,
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
    principal: KodaPrincipal,
  ): Promise<TransitionResultWithComment> {
    const ticket = await this.findTicketByRef(projectSlug, ticketRef);
    if (ticket?.status === TicketStatus.VERIFY_FIX) {
      return this.executeTransition(
        projectSlug,
        ticketRef,
        TicketStatus.CLOSED,
        CommentType.REVIEW,
        commentBody ?? 'Verified',
        principal,
      ) as Promise<TransitionResultWithComment>;
    }
    return this.executeTransition(
      projectSlug,
      ticketRef,
      TicketStatus.VERIFIED,
      CommentType.VERIFICATION,
      commentBody ?? 'Verified',
      principal,
    ) as Promise<TransitionResultWithComment>;
  }

  /**
   * Transition VERIFIED → IN_PROGRESS (no comment required)
   */
  async start(
    projectSlug: string,
    ticketRef: string,
    principal: KodaPrincipal,
  ): Promise<TransitionResultWithoutComment> {
    return this.executeTransition(
      projectSlug,
      ticketRef,
      TicketStatus.IN_PROGRESS,
      undefined,
      undefined,
      principal,
    ) as Promise<TransitionResultWithoutComment>;
  }

  /**
   * Transition IN_PROGRESS → VERIFY_FIX
   */
  async fix(
    projectSlug: string,
    ticketRef: string,
    commentBody: string,
    principal: KodaPrincipal,
  ): Promise<TransitionResultWithComment> {
    return this.executeTransition(
      projectSlug,
      ticketRef,
      TicketStatus.VERIFY_FIX,
      CommentType.FIX_REPORT,
      commentBody ?? 'Fix submitted',
      principal,
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
    principal: KodaPrincipal,
  ): Promise<TransitionResultWithComment> {
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
      principal,
    ) as Promise<TransitionResultWithComment>;
  }

  /**
   * Transition to CLOSED from any valid status (no comment required)
   * Bypasses normal transition rules to allow closing from multiple states
   */
  async close(
    projectSlug: string,
    ticketRef: string,
    principal: KodaPrincipal,
  ): Promise<TransitionResultWithoutComment> {
    const project = await this.ticketRepo.findProjectBySlug(projectSlug);
    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'tickets');
    }

    const ticket = await this.findTicketByRef(projectSlug, ticketRef);
    if (!ticket) {
      throw new NotFoundAppException({}, 'tickets');
    }

    if (
      ticket.status === TicketStatus.CLOSED ||
      ticket.status === TicketStatus.CREATED ||
      ticket.status === TicketStatus.REJECTED
    ) {
      throw new ValidationAppException({}, 'tickets');
    }

    const repo = this.ticketRepo as import('../prisma-tickets.repository').PrismaTicketsRepository;

    const transaction = await this.txManager.run(async () => {
      const actorFields = actorForeignKeys(principal, 'actor');

      const updatedTicket = await repo.updateTicketStatus(ticket.id, TicketStatus.CLOSED);

      const activity = await repo.createTicketActivity({
        ticketId: ticket.id,
        action: ActivityType.STATUS_CHANGE,
        fromStatus: ticket.status,
        toStatus: TicketStatus.CLOSED,
        ...actorFields,
      });

      return {
        ticket: updatedTicket as unknown as Ticket,
        activity: activity as unknown as TicketActivity,
      };
    });

    this.autoIndexTicket(project, transaction.ticket as unknown as TicketDomain);
    this.dispatchStatusChangeWebhook(project.id, transaction.ticket as unknown as TicketDomain, ticket.status, TicketStatus.CLOSED);

    return transaction;
  }

  /**
   * Transition CREATED or VERIFIED → REJECTED
   */
  async reject(
    projectSlug: string,
    ticketRef: string,
    commentBody: string,
    principal: KodaPrincipal,
  ): Promise<TransitionResultWithComment> {
    return this.executeTransition(
      projectSlug,
      ticketRef,
      TicketStatus.REJECTED,
      CommentType.GENERAL,
      commentBody,
      principal,
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
    principal: KodaPrincipal,
  ): Promise<TransitionResult> {
    const project = await this.ticketRepo.findProjectBySlug(projectSlug);
    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'tickets');
    }

    const ticket = await this.findTicketByRef(projectSlug, ticketRef);
    if (!ticket) {
      throw new NotFoundAppException({}, 'tickets');
    }

    validateTransition(ticket.status as TicketStatus, toStatus, commentType);

    const repo = this.ticketRepo as import('../prisma-tickets.repository').PrismaTicketsRepository;

    const result = await this.txManager.run(async () => {
      const actorFields = actorForeignKeys(principal, 'actor');

      let comment = null;
      if (commentType && commentBody) {
        const authorFields = actorForeignKeys(principal, 'authoredBy');
        comment = await repo.createComment({
          ticketId: ticket.id,
          body: commentBody,
          type: commentType,
          authorUserId: authorFields.authorUserId,
          authorAgentId: authorFields.authorAgentId,
        });
      }

      const updatedTicket = await repo.updateTicketStatus(ticket.id, toStatus);

      const activity = await repo.createTicketActivity({
        ticketId: ticket.id,
        action: ActivityType.STATUS_CHANGE,
        fromStatus: ticket.status,
        toStatus,
        ...actorFields,
      });

      if (comment) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return {
          ticket: updatedTicket as unknown as Ticket,
          comment: comment as unknown as Comment,
          activity: activity as unknown as TicketActivity,
        } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return {
        ticket: updatedTicket as unknown as Ticket,
        activity: activity as unknown as TicketActivity,
      } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    });

    if (toStatus === TicketStatus.CLOSED) {
      this.autoIndexTicket(project, result.ticket as unknown as TicketDomain);
    }
    this.dispatchStatusChangeWebhook(project.id, result.ticket as unknown as TicketDomain, ticket.status, toStatus);
    if (toStatus === TicketStatus.VERIFIED) {
      await this.createPrForTicket(project, result.ticket as unknown as TicketDomain);
    }
    return result;
  }

  /**
   * Helper to find ticket by ref (supports both KODA-1 format and CUID)
   */
  private async findTicketByRef(projectSlug: string, ref: string): Promise<TicketDomain | null> {
    return this.ticketRepo.findTicketByRefRaw(projectSlug, ref);
  }
}

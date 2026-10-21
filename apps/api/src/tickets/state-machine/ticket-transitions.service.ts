import { Injectable, Optional, Logger, Inject, HttpException, HttpStatus } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { NotFoundAppException, ValidationAppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import { TicketStatus, CommentType, ActivityType } from '../../common/enums';
import { validateTransition } from './ticket-transitions';
import { transitionKeyFor } from './transition-keys';
import { PermissionService } from '../../permissions/permission.service';
import { RagService } from '../../rag/rag.service';
import { WebhookDispatcherService } from '../../webhook/webhook-dispatcher.service';
import { VcsConnectionService } from '../../vcs/vcs-connection.service';
import { buildBranchName } from '../../vcs/branch-name.util';
import { providerForConnection } from '../../vcs/provider-for-connection';
import { VcsLinkExtractorService } from '../../vcs/vcs-link-extractor.service';
import { VCS_CFG, IVcsConfig } from '../../config/vcs.config';
import { decryptToken } from '../../common/utils/encryption.util';
import { TicketLinksService } from '../../ticket-links/ticket-links.service';
import { actorForeignKeys } from '../../auth/principal/actor-foreign-keys';
import { actorKind, KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { TICKET_REPOSITORY, ITicketRepository } from '../domain/ticket.domain';
import type { TicketDomain } from '../domain/ticket.domain';
import { TicketEventService } from '../../events/ticket-event.service';
import { buildTicketEventOutboxPayload } from '../../events/outbox-envelope.util';
import { OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';

export interface TransitionTicketShape {
  id: string;
  status: string;
  title: string;
  projectId: string;
  number: number;
  [key: string]: unknown;
}

export interface TransitionCommentShape {
  id: string;
  ticketId: string;
  body: string;
  type: string;
  [key: string]: unknown;
}

export interface TransitionActivityShape {
  id: string;
  ticketId: string;
  action: string;
  [key: string]: unknown;
}

export interface TransitionResultWithComment {
  ticket: TransitionTicketShape;
  comment: TransitionCommentShape;
  activity: TransitionActivityShape;
}

export interface TransitionResultWithoutComment {
  ticket: TransitionTicketShape;
  activity: TransitionActivityShape;
}

export type TransitionResult = TransitionResultWithComment | TransitionResultWithoutComment;

/**
 * Permissions P1 (whole-branch fix B3): the field writes a `PATCH /projects/:slug/tickets/:ref` sends
 * alongside a `status`.
 *
 * They run inside the transition's own transaction, after the conditional status write, so the PATCH is
 * one operation: a refused edge key, a validation failure or a lost status race rolls the fields — and
 * the events they recorded — back with everything else, and a caller never sees a 403 or 409 that
 * nevertheless kept the new title.
 *
 * `previous` is the ticket as the transition loaded it, before any write of this call (the mention
 * diff needs the earlier description). The returned row is the ticket after the field write and becomes
 * the response body; a patch that returns nothing answers the row of the status write.
 */
export interface TransitionFieldPatchContext {
  ticketId: string;
  projectId: string;
  previous: TransitionTicketShape;
}

export type TransitionFieldPatch = (
  context: TransitionFieldPatchContext,
) => Promise<TransitionTicketShape | undefined>;

@Injectable()
export class TicketTransitionsService {
  private readonly logger = new Logger(TicketTransitionsService.name);

  constructor(
    @Inject(TICKET_REPOSITORY) private readonly ticketRepo: ITicketRepository,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    // Permissions P1 (US-003): the edge check's one decision point. Required: no transition route is
    // authorized without it, and an optional dependency here would silently skip the check.
    private readonly permissions: PermissionService,
    @Optional() private readonly ragService?: RagService,
    @Optional() private readonly webhookDispatcher?: WebhookDispatcherService,
    @Optional() private readonly vcsConnectionService?: VcsConnectionService,
    @Optional() private readonly ticketLinksService?: TicketLinksService,
    @Optional() private readonly vcsLinkExtractorService?: VcsLinkExtractorService,
    @Optional() @Inject(VCS_CFG) private readonly vcsConfig?: IVcsConfig,
    // H13: optional so the existing vcs integration tests that construct this
    // service positionally keep working; emission is skipped when absent.
    @Optional() private readonly ticketEventService?: TicketEventService,
    @Optional() private readonly outboxService?: NathappOutboxService,
  ) {}

  /**
   * H13: records a status_changed ticket_event (full envelope) for the memory
   * and entity-graph consumers. Called inside the transition transaction.
   */
  private async recordStatusChangedEvent(
    projectId: string,
    ticketId: string,
    fromStatus: string,
    toStatus: string,
    principal: KodaPrincipal,
  ): Promise<void> {
    if (!this.ticketEventService || !this.outboxService) return;
    const actorType = actorKind(principal);
    const data = { fromStatus, newStatus: toStatus };
    const event = await this.ticketEventService.create({
      ticketId,
      projectId,
      action: 'status_changed',
      actorId: principal.id,
      actorType,
      source: 'internal',
      data,
    });
    await this.outboxService.record({
      type: 'ticket_event',
      payload: buildTicketEventOutboxPayload({ event, ticketId, projectId, actorId: principal.id, actorType, data }),
      metadata: { projectId, eventId: event.id },
    });
  }

  /** COMMENT_ADDED for a comment written inside a transition transaction. */
  private async recordCommentAddedEvent(
    projectId: string,
    ticketId: string,
    commentId: string,
    principal: KodaPrincipal,
  ): Promise<void> {
    if (!this.ticketEventService || !this.outboxService) return;
    const actorType = actorKind(principal);
    const data = { commentId };
    const event = await this.ticketEventService.create({
      ticketId,
      projectId,
      action: 'COMMENT_ADDED',
      actorId: principal.id,
      actorType,
      source: 'internal',
      data,
    });
    await this.outboxService.record({
      type: 'ticket_event',
      payload: buildTicketEventOutboxPayload({ event, ticketId, projectId, actorId: principal.id, actorType, data }),
      metadata: { projectId, eventId: event.id },
    });
  }

  /**
   * Records the STATUS_CHANGE webhook rows for a transition. Called inside the
   * transition transaction so they commit (or roll back) with it.
   */
  private async recordStatusChangeWebhooks(
    projectId: string,
    projectKey: string,
    ticket: TicketDomain,
    fromStatus: string,
    toStatus: string,
  ): Promise<void> {
    if (!this.webhookDispatcher) return;

    await this.webhookDispatcher.dispatch(projectId, 'STATUS_CHANGE', {
      event: 'STATUS_CHANGE',
      timestamp: new Date().toISOString(),
      // BUG-15: report the human-readable ref (KODA-42), not the DB CUID
      ticket: { id: ticket.id, ref: `${projectKey}-${ticket.number}`, status: toStatus },
      from: fromStatus,
      to: toStatus,
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
        // M15: a ticket deleted while this fire-and-forget index was pending must
        // not be re-added after the TICKET_DELETED handler removed it.
        if (!ticketFull || ticketFull.deletedAt) return;
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
      .catch((err) => {
        this.logger.warn(
          `[rag] Failed to auto-index ticket ${ticket.id} on close: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /**
   * Fire-and-forget: create a GitHub PR when ticket transitions to VERIFIED.
   * Only runs when VCS connection exists and VcsConnectionService/TicketLinksService are available.
   */
  private async createPrForTicket(
    project: { id: string; key: string },
    ticket: TicketDomain,
  ): Promise<void> {
    const vcsService = this.vcsConnectionService;
    const vcsLinkExtractor = this.vcsLinkExtractorService;
    const vcsConfig = this.vcsConfig;
    if (!vcsService || !this.ticketLinksService || !vcsLinkExtractor || !vcsConfig) return;

    const encryptionKey = vcsConfig.encryptionKey;
    if (!encryptionKey) return;

    const projectId = project.id;
    const ticketId = ticket.id;
    const projectKey = project.key;

    // Fleet C9 follow-up (#231): the classic auto-PR yields to fleet. When
    // fleet already owns the ticket (a fleet PR link, or a non-terminal fleet
    // job), a KEY-N draft PR here would leave two open PRs for the same work.
    // Best-effort: a failed lookup falls back to the classic path.
    try {
      if (await this.ticketRepo.hasFleetOwnership(ticketId)) {
        this.logger.debug(
          `[vcs] Skipping classic PR for ${projectKey}-${ticket.number}: fleet owns the ticket`,
        );
        return;
      }
    } catch (err) {
      this.logger.warn(
        `[vcs] Fleet-ownership lookup failed for ticket ${ticketId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let createdPrNumber: number | undefined;
    const repo = this.ticketRepo as import('../prisma-tickets.repository').PrismaTicketsRepository;

    try {
      const connection = await vcsService.getFullByProject(projectId);
      if (!connection.isActive) return;

      const token = decryptToken(connection.encryptedToken, encryptionKey);
      const provider = providerForConnection(connection, token, vcsConfig);
      const baseBranch = await provider.getDefaultBranch();
      const branchName = buildBranchName(projectKey, ticket.number, ticket.title);
      const prTitle = `${projectKey}-${ticket.number}: ${ticket.title}`;
      const prBody = ticket.description ?? '';

      try {
        // BUG-13: create the PR first and persist the TicketLink only on
        // success. The old flow wrote a `.../pulls/pending` placeholder
        // before creating the PR, leaving a dead link behind whenever the
        // provider call failed.
        const pr = await provider.createPullRequest({
          title: prTitle,
          body: prBody,
          branchName,
          baseBranch,
          draft: true,
        });
        createdPrNumber = pr.number;
        await repo.createTicketLink({
          ticketId,
          url: pr.url,
          provider: connection.provider,
          externalRef: `${connection.repoOwner}/${connection.repoName}#${pr.number}`,
          prNumber: pr.number,
          prState: 'draft',
          prUpdatedAt: new Date(),
          linkType: 'pr',
        });
        await repo.createTicketActivity({
          ticketId,
          action: ActivityType.VCS_PR_CREATED,
        });
        // AC5: After createPrForTicket() completes, extractLinksFromPr() is called
        if (createdPrNumber === undefined) {
          // Defensive: never fall back to /pulls/0 if this chain is refactored.
          return;
        }
        await vcsLinkExtractor.extractLinksFromPr(
          project,
          { id: ticket.id, number: ticket.number, externalVcsId: null },
          connection,
          encryptionKey,
          branchName,
          createdPrNumber,
        );
      } catch (err) {
        this.logger.warn(
          `[vcs] Failed to create PR for ticket ${projectKey}-${ticket.number}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `[vcs] Failed to initiate PR creation for ticket in project ${projectId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
      return this.executeTransitionInternal(
        projectSlug,
        ticketRef,
        TicketStatus.CLOSED,
        CommentType.REVIEW,
        commentBody ?? 'Verified',
        principal,
      ) as Promise<TransitionResultWithComment>;
    }
    return this.executeTransitionInternal(
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
    return this.executeTransitionInternal(
      projectSlug,
      ticketRef,
      TicketStatus.IN_PROGRESS,
      undefined,
      undefined,
      principal,
    ) as Promise<TransitionResultWithoutComment>;
  }

  /**
   * Permissions P1d (US-003): the dispatch-only `start`.
   *
   * A RUN dispatch starts each CREATED/VERIFIED ticket it names as a consequence of a request the
   * caller was already allowed to make with `fleet.job.dispatch` — so the caller is not asked for the
   * ticket's edge key, which a fleet-dispatch-only role does not hold. Everything else is exactly
   * `start`: the state-machine validation, the conditional status write, the STATUS_CHANGE activity
   * row with the dispatcher as actor, the webhook and the ticket event.
   *
   * Only `FleetJobTicketEffects.onRunDispatched` may call this; a route or tool that moves a ticket on
   * a user's behalf must go through `start`, which checks `ticket.transition.start`.
   */
  async startForDispatch(
    projectSlug: string,
    ticketRef: string,
    principal: KodaPrincipal,
  ): Promise<TransitionResultWithoutComment> {
    return this.executeTransitionInternal(
      projectSlug,
      ticketRef,
      TicketStatus.IN_PROGRESS,
      undefined,
      undefined,
      principal,
      undefined,
      { skipEdgeCheck: true },
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
    return this.executeTransitionInternal(
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
    return this.executeTransitionInternal(
      projectSlug,
      ticketRef,
      toStatus,
      CommentType.REVIEW,
      commentBody,
      principal,
    ) as Promise<TransitionResultWithComment>;
  }

  /**
   * Admin override: close from IN_PROGRESS, VERIFIED or VERIFY_FIX with a
   * required reason, written as a GENERAL comment in the same transaction as
   * the status change. Authorization (global/project ADMIN) is decided by the
   * controller from the request's ProjectContext; the normal path to CLOSED
   * remains verify-fix approve.
   */
  async close(
    projectSlug: string,
    ticketRef: string,
    reason: string,
    principal: KodaPrincipal,
  ): Promise<TransitionResultWithComment> {
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

      // M3: conditional write first, so a lost race rolls back before any
      // comment row exists.
      const updatedTicket = await repo.updateTicketStatusIf(ticket.id, ticket.status, TicketStatus.CLOSED);
      if (!updatedTicket) {
        // 409 pattern copied from webhook-replay.guard.ts:148 (ConflictAppException
        // does not exist in @nathapp/nestjs-common). Thrown inside the tx callback
        // so PrismaTransactionManager.run propagates it and rolls back.
        throw new HttpException('Ticket state changed concurrently', HttpStatus.CONFLICT);
      }

      const authorFields = actorForeignKeys(principal, 'authoredBy');
      const comment = await repo.createComment({
        ticketId: ticket.id,
        body: reason,
        type: CommentType.GENERAL,
        authorUserId: authorFields.authorUserId,
        authorAgentId: authorFields.authorAgentId,
      });

      const activity = await repo.createTicketActivity({
        ticketId: ticket.id,
        action: ActivityType.STATUS_CHANGE,
        fromStatus: ticket.status,
        toStatus: TicketStatus.CLOSED,
        ...actorFields,
      });

      await this.recordStatusChangeWebhooks(project.id, project.key, updatedTicket as unknown as TicketDomain, ticket.status, TicketStatus.CLOSED);
      await this.recordStatusChangedEvent(project.id, ticket.id, ticket.status, TicketStatus.CLOSED, principal);
      await this.recordCommentAddedEvent(project.id, ticket.id, comment.id, principal);

      return {
        ticket: updatedTicket as unknown as TransitionTicketShape,
        comment: comment as unknown as TransitionCommentShape,
        activity: activity as unknown as TransitionActivityShape,
      };
    });

    this.autoIndexTicket(project, transaction.ticket as unknown as TicketDomain);

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
    return this.executeTransitionInternal(
      projectSlug,
      ticketRef,
      TicketStatus.REJECTED,
      CommentType.GENERAL,
      commentBody,
      principal,
    ) as Promise<TransitionResultWithComment>;
  }

  /**
   * Permissions P1 (US-003): the edge check. The caller must hold the key of the edge that leads
   * from the ticket's *current* status to `toStatus` — the route key only says the caller may make
   * that kind of move, this says the ticket's state allows it for them. A pair with no key is not an
   * edge of the state machine (`CREATED -> CLOSED`), so nothing is checked and `validateTransition`
   * answers for it.
   */
  private async assertEdgeAllowed(
    projectId: string,
    fromStatus: TicketStatus,
    toStatus: TicketStatus,
    principal: KodaPrincipal,
  ): Promise<void> {
    const key = transitionKeyFor(fromStatus, toStatus);
    if (key === undefined) return;
    const decision = await this.permissions.can(principal, key, { projectId });
    if (!decision.allowed) {
      throw new ForbiddenAppException({}, 'permissions');
    }
  }

  /**
   * Permissions P1 (US-003): the edge check for `PATCH /projects/:slug/tickets/:ref` with a
   * `status`. It loads the project and the ticket (the 404s) and applies the same edge check as a
   * transition, without validating the transition — so a refused edge still writes no field.
   */
  async assertTransitionAllowed(
    projectSlug: string,
    ref: string,
    toStatus: TicketStatus,
    principal: KodaPrincipal,
  ): Promise<void> {
    const project = await this.ticketRepo.findProjectBySlug(projectSlug);
    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'tickets');
    }

    const ticket = await this.findTicketByRef(projectSlug, ref);
    if (!ticket) {
      throw new NotFoundAppException({}, 'tickets');
    }

    await this.assertEdgeAllowed(project.id, ticket.status as TicketStatus, toStatus, principal);
  }

  /**
   * M2: public entry for status changes routed from PATCH /projects/:slug/tickets/:ref.
   * Runs the full transition pipeline (state-machine validation, conditional
   * status write, activity row, webhook dispatch) instead of the direct `status`
   * write the PATCH route used before.
   *
   * Permissions P1 (US-003): authorization for this caller path is the route's
   * `@Requires('ticket.update')` plus the current-status edge key that
   * `executeTransitionInternal` checks before validating or writing anything.
   *
   * Whole-branch fix B3: `fields` carries the PATCH's other field writes into that same transaction, so
   * the status and the fields commit or roll back together.
   */
  async executeTransitionPublic(
    projectSlug: string,
    ticketRef: string,
    toStatus: TicketStatus,
    principal: KodaPrincipal,
    fields?: TransitionFieldPatch,
  ): Promise<TransitionResult> {
    // Permissions P1 (US-003): no route key check here — the route declares its own key and
    // `executeTransitionInternal` checks the ticket's current-status edge, for every caller.
    return this.executeTransitionInternal(projectSlug, ticketRef, toStatus, undefined, undefined, principal, fields);
  }

  /**
   * Core transition execution logic with validation and transaction handling
   *
   * `options.skipEdgeCheck` is the dispatch's one exemption (`startForDispatch`): the caller was
   * authorized for the fleet request that starts the ticket, not for the ticket's edge key. Every
   * other caller path leaves it unset.
   */
  private async executeTransitionInternal(
    projectSlug: string,
    ticketRef: string,
    toStatus: TicketStatus,
    commentType: CommentType | undefined,
    commentBody: string | undefined,
    principal: KodaPrincipal,
    fields?: TransitionFieldPatch,
    options: { skipEdgeCheck?: boolean } = {},
  ): Promise<TransitionResult> {
    const project = await this.ticketRepo.findProjectBySlug(projectSlug);
    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'tickets');
    }

    const ticket = await this.findTicketByRef(projectSlug, ticketRef);
    if (!ticket) {
      throw new NotFoundAppException({}, 'tickets');
    }

    // Permissions P1 (US-003): the edge check, before validation and before any write, so a refused
    // edge leaves no comment, no activity row and no status change behind.
    if (!options.skipEdgeCheck) {
      await this.assertEdgeAllowed(project.id, ticket.status as TicketStatus, toStatus, principal);
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

      // M3: conditional write keyed on the status read before the transaction —
      // a concurrent writer (verify vs reject race) makes this match 0 rows and
      // fail closed with 409 instead of double-committing.
      const updatedTicket = await repo.updateTicketStatusIf(ticket.id, ticket.status, toStatus);
      if (!updatedTicket) {
        // 409 pattern copied from webhook-replay.guard.ts:148 (ConflictAppException
        // does not exist in @nathapp/nestjs-common). Thrown inside the tx callback
        // so PrismaTransactionManager.run propagates it and rolls back.
        throw new HttpException('Ticket state changed concurrently', HttpStatus.CONFLICT);
      }

      // Whole-branch fix B3: the PATCH's field writes belong to this transaction and come after the
      // conditional status write, so a lost status race has already thrown and nothing is left behind.
      const patched = fields
        ? await fields({
            ticketId: ticket.id,
            projectId: project.id,
            previous: ticket as unknown as TransitionTicketShape,
          })
        : undefined;
      const responseTicket = patched ?? (updatedTicket as unknown as TransitionTicketShape);

      const activity = await repo.createTicketActivity({
        ticketId: ticket.id,
        action: ActivityType.STATUS_CHANGE,
        fromStatus: ticket.status,
        toStatus,
        ...actorFields,
      });

      await this.recordStatusChangeWebhooks(project.id, project.key, updatedTicket as unknown as TicketDomain, ticket.status, toStatus);
      await this.recordStatusChangedEvent(project.id, ticket.id, ticket.status, toStatus, principal);

      if (comment) {
        return {
          ticket: responseTicket,
          comment: comment as unknown as TransitionCommentShape,
          activity: activity as unknown as TransitionActivityShape,
        } satisfies TransitionResultWithComment;
      }

      return {
        ticket: responseTicket,
        activity: activity as unknown as TransitionActivityShape,
      } satisfies TransitionResultWithoutComment;
    });

    if (toStatus === TicketStatus.CLOSED) {
      this.autoIndexTicket(project, result.ticket as unknown as TicketDomain);
    }
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

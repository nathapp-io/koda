import { Injectable, Inject } from '@nestjs/common';
import { CommentType } from '../common/enums';
import { ValidationAppException, NotFoundAppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { CommentResponseDto } from './dto/comment-response.dto';
import { PrismaCommentRepository } from './prisma-comment.repository';
import { COMMENT_REPOSITORY, CommentDomain } from './domain/comment.domain';
import { KodaPrincipal, actorKind } from '../auth/principal/koda-principal.types';
import { actorForeignKeys } from '../auth/principal/actor-foreign-keys';
import { PermissionService } from '../permissions/permission.service';
import type { PrincipalRef } from '../permissions/permissions.types';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';
import { TicketEventService } from '../events/ticket-event.service';
import { buildTicketEventOutboxPayload } from '../events/outbox-envelope.util';
import { ProjectAccessService } from '../projects/project-access.service';

@Injectable()
export class CommentsService {
  constructor(
    @Inject(COMMENT_REPOSITORY) private readonly commentRepo: PrismaCommentRepository,
    private readonly permissions: PermissionService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly ticketEventService: TicketEventService,
    private readonly outbox: NathappOutboxService,
    private readonly access: ProjectAccessService,
  ) {}

  private async resolveTicketByRef(projectSlug: string, ticketRef: string) {
    const project = await this.commentRepo.findProjectBySlug(projectSlug);

    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'comments');
    }

    // H5: scoped resolution — KEY-N prefix must match the project key and
    // CUIDs are constrained to this project; soft-deleted tickets miss.
    const ticket = await this.commentRepo.findTicketScoped(project.id, project.key, ticketRef);

    if (!ticket || ticket.deletedAt) {
      throw new NotFoundAppException({}, 'comments');
    }

    return { project, ticket };
  }

  /**
   * US-002: resolve a comment to its owning project so the slug-less mutation
   * paths can gate by membership before the key check (Permissions P1 US-005).
   * Returns the resolved project id and the comment itself (throwing
   * `NotFoundAppException` if the comment, ticket, or project is
   * missing/soft-deleted, or if the caller is not a project member).
   */
  private async assertCommentProjectMembership(
    commentId: string,
    principal: KodaPrincipal,
  ): Promise<{ projectId: string; comment: CommentDomain }> {
    const ownership = await this.commentRepo.findOwningProjectAndTicket(commentId);

    if (!ownership || ownership.ticket.deletedAt || ownership.project.deletedAt) {
      throw new NotFoundAppException({}, 'comments');
    }

    // Agents resolve to null without a lookup; global ADMIN resolves to 'ADMIN'.
    // A non-member's 403 becomes 404 so the comment's existence stays hidden.
    try {
      await this.access.resolveMembership(ownership.project.id, principal);
    } catch (err) {
      if (err instanceof ForbiddenAppException) throw new NotFoundAppException({}, 'comments');
      throw err;
    }
    return { projectId: ownership.project.id, comment: ownership.comment };
  }

  /**
   * US-005: the row-level half of the check. The route declares
   * `comment.update` / `comment.delete` with `enforcedBy: 'service'` because
   * only here is the comment's project and author known; a caller holding just
   * `X.own` is allowed exactly on the comment it wrote.
   */
  private async assertCommentKey(
    principal: KodaPrincipal,
    key: 'comment.update' | 'comment.delete',
    projectId: string,
    comment: CommentDomain,
  ): Promise<void> {
    const decision = await this.permissions.can(principal, key, {
      projectId,
      resource: { createdBy: commentAuthor(comment) },
    });
    if (!decision.allowed) throw new ForbiddenAppException({}, 'permissions');
  }

  /**
   * Slice 5: writes the COMMENT_ADDED TicketEvent row and its ticket_event
   * outbox row. Must run inside the comment's txManager.run so all three
   * commit or roll back together. Carries the comment id, never its body.
   */
  private async recordCommentAdded(
    ticketId: string,
    projectId: string,
    commentId: string,
    principal: KodaPrincipal,
  ): Promise<void> {
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
    await this.outbox.record({
      type: 'ticket_event',
      payload: buildTicketEventOutboxPayload({ event, ticketId, projectId, actorId: principal.id, actorType, data }),
      metadata: { projectId, eventId: event.id },
    });
  }

  async create(
    projectSlug: string,
    ticketRef: string,
    createCommentDto: CreateCommentDto,
    principal: KodaPrincipal,
  ) {
    if (!createCommentDto.body) {
      throw new ValidationAppException({}, 'comments');
    }
    if (typeof createCommentDto.body === 'string' && createCommentDto.body.trim().length === 0) {
      throw new ValidationAppException({}, 'comments');
    }
    if (!createCommentDto.type) {
      createCommentDto.type = CommentType.GENERAL;
    }

    const { project, ticket } = await this.resolveTicketByRef(projectSlug, ticketRef);

    const comment = await this.txManager.run(async () => {
      // id/createdAt/updatedAt are DB-generated; toPersistenceCreate strips them.
      const created = await this.commentRepo.create({
        id: '',
        ticketId: ticket.id,
        body: createCommentDto.body,
        type: createCommentDto.type as CommentType,
        ...actorForeignKeys(principal, 'authoredBy'),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await this.recordCommentAdded(ticket.id, project.id, created.id, principal);
      return created;
    });

    return CommentResponseDto.from(comment);
  }

  async findByTicket(projectSlug: string, ticketRef: string) {
    const { ticket } = await this.resolveTicketByRef(projectSlug, ticketRef);
    const comments = await this.commentRepo.findByTicketId(ticket.id);
    return CommentResponseDto.fromMany(comments);
  }

  /**
   * US-003 fix F1: a ticket's newest `limit` comments, oldest first, plus how many the ticket holds. The bounded
   * read keeps a long comment history out of memory — `findByTicket` loads every row — while `total` lets the caller
   * say what it left out.
   */
  async findRecentByTicket(
    projectSlug: string,
    ticketRef: string,
    limit: number,
  ): Promise<{ comments: CommentResponseDto[]; total: number }> {
    const { ticket } = await this.resolveTicketByRef(projectSlug, ticketRef);
    const [comments, total] = await Promise.all([
      this.commentRepo.findRecentByTicketId(ticket.id, limit),
      this.commentRepo.countByTicketId(ticket.id),
    ]);
    return { comments: CommentResponseDto.fromMany(comments), total };
  }

  async findById(id: string) {
    const comment = await this.commentRepo.findById(id);

    return comment ? CommentResponseDto.from(comment) : null;
  }

  async update(
    commentId: string,
    updateCommentDto: UpdateCommentDto,
    principal: KodaPrincipal,
  ) {
    // US-002: resolve comment → ticket → project and gate by membership first; a
    // non-member user gets 404 so the comment's existence stays hidden.
    // US-005: then the row-level key check — `comment.update` (or `.own` on this
    // author) decides, and a refusal is 403 `permissions`.
    const { projectId, comment } = await this.assertCommentProjectMembership(commentId, principal);
    await this.assertCommentKey(principal, 'comment.update', projectId, comment);

    // Update the comment via repository
    const updatedComment = await this.commentRepo.update(commentId, {
      body: updateCommentDto.body,
    });

    return CommentResponseDto.from(updatedComment);
  }

  async delete(
    commentId: string,
    principal: KodaPrincipal,
  ) {
    // US-002: same membership gate as `update`. Global ADMINs and agents
    // proceed; non-member users get 404 (not 403) so the comment's existence
    // stays hidden.
    // US-005: a project admin holds `comment.delete`; every other role is held to
    // `comment.delete.own` and refused on someone else's comment.
    const { projectId, comment } = await this.assertCommentProjectMembership(commentId, principal);
    await this.assertCommentKey(principal, 'comment.delete', projectId, comment);

    // Delete the comment via repository
    await this.commentRepo.delete(commentId);
  }
}

/** Who wrote the comment, as `PermissionService.can` compares it for an `.own` key. */
function commentAuthor(comment: CommentDomain): PrincipalRef | null {
  if (comment.authorUserId) return { type: 'USER', id: comment.authorUserId };
  if (comment.authorAgentId) return { type: 'AGENT', id: comment.authorAgentId };
  return null;
}

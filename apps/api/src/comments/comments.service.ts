import { Injectable, Inject } from '@nestjs/common';
import { subject } from '@casl/ability';
import { CaslPermissionAction } from '@nathapp/nestjs-auth';
import { CommentType } from '../common/enums';
import { ValidationAppException, NotFoundAppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { CommentResponseDto } from './dto/comment-response.dto';
import { PrismaCommentRepository } from './prisma-comment.repository';
import { COMMENT_REPOSITORY, CommentDomain } from './domain/comment.domain';
import { KodaPrincipal, actorKind } from '../auth/principal/koda-principal.types';
import { actorForeignKeys } from '../auth/principal/actor-foreign-keys';
import { KodaCaslAbilityFactory } from '../auth/casl/koda-casl-ability.factory';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';
import { TicketEventService } from '../events/ticket-event.service';
import { buildTicketEventOutboxPayload } from '../events/outbox-envelope.util';
import { ProjectAccessService } from '../projects/project-access.service';
import { withProjectRole } from '../projects/project-context';

@Injectable()
export class CommentsService {
  constructor(
    @Inject(COMMENT_REPOSITORY) private readonly commentRepo: PrismaCommentRepository,
    private readonly caslAbilityFactory: KodaCaslAbilityFactory,
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
   * paths can gate by membership before the CASL check. Returns the resolved
   * project id and the caller's project role (throwing
   * `NotFoundAppException` if the comment, ticket, or project is
   * missing/soft-deleted, or if the caller is not a project member).
   */
  private async assertCommentProjectMembership(
    commentId: string,
    principal: KodaPrincipal,
  ): Promise<{ projectId: string; role: string | null; comment: CommentDomain }> {
    const ownership = await this.commentRepo.findOwningProjectAndTicket(commentId);

    if (!ownership || ownership.ticket.deletedAt || ownership.project.deletedAt) {
      throw new NotFoundAppException({}, 'comments');
    }

    // Agents resolve to null without a lookup; global ADMIN resolves to 'ADMIN'.
    // A non-member's 403 becomes 404 so the comment's existence stays hidden.
    try {
      const role = await this.access.resolveMembership(ownership.project.id, principal);
      return { projectId: ownership.project.id, role, comment: ownership.comment };
    } catch (err) {
      if (err instanceof ForbiddenAppException) throw new NotFoundAppException({}, 'comments');
      throw err;
    }
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

  async findById(id: string) {
    const comment = await this.commentRepo.findById(id);

    return comment ? CommentResponseDto.from(comment) : null;
  }

  async update(
    commentId: string,
    updateCommentDto: UpdateCommentDto,
    principal: KodaPrincipal,
  ) {
    // US-002: resolve comment → ticket → project and gate by membership before
    // the CASL check. A non-member user gets 404 (their membership lookup is
    // translated from ForbiddenAppException); agents resolve to role null and
    // proceed to the CASL check unchanged.
    // #145: the membership gate's query already returned the comment.
    const { role, comment } = await this.assertCommentProjectMembership(commentId, principal);

    // #144: the ability is built from the principal enriched with the project
    // role, so a project ADMIN gains unconditional DELETE and everyone else is
    // held to the author-only rules.
    const ability = await this.caslAbilityFactory.createForUser(withProjectRole(principal, role));
    if (!ability.can(CaslPermissionAction.UPDATE, subject('Comment', comment))) {
      throw new ForbiddenAppException({}, 'comments');
    }

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
    // #145: the membership gate's query already returned the comment.
    const { role, comment } = await this.assertCommentProjectMembership(commentId, principal);

    // #144: a project ADMIN may delete anyone's comment in the project; other
    // roles remain author-only.
    const ability = await this.caslAbilityFactory.createForUser(withProjectRole(principal, role));
    if (!ability.can(CaslPermissionAction.DELETE, subject('Comment', comment))) {
      throw new ForbiddenAppException({}, 'comments');
    }

    // Delete the comment via repository
    await this.commentRepo.delete(commentId);
  }
}

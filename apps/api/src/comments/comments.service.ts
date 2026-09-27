import { Injectable, Inject } from '@nestjs/common';
import { subject } from '@casl/ability';
import { CaslPermissionAction } from '@nathapp/nestjs-auth';
import { CommentType } from '../common/enums';
import { ValidationAppException, NotFoundAppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { CommentResponseDto } from './dto/comment-response.dto';
import { PrismaCommentRepository } from './prisma-comment.repository';
import { COMMENT_REPOSITORY } from './domain/comment.domain';
import { KodaPrincipal, isUserPrincipal } from '../auth/principal/koda-principal.types';
import { KodaCaslAbilityFactory } from '../auth/casl/koda-casl-ability.factory';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';
import { TicketEventService } from '../events/ticket-event.service';
import { buildTicketEventOutboxPayload } from '../events/outbox-envelope.util';

@Injectable()
export class CommentsService {
  constructor(
    @Inject(COMMENT_REPOSITORY) private readonly commentRepo: PrismaCommentRepository,
    private readonly caslAbilityFactory: KodaCaslAbilityFactory,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly ticketEventService: TicketEventService,
    private readonly outbox: NathappOutboxService,
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
    const actorType = isUserPrincipal(principal) ? 'user' : 'agent';
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
        authorUserId: isUserPrincipal(principal) ? principal.id : null,
        authorAgentId: isUserPrincipal(principal) ? null : principal.id,
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
    // Find the comment via repository
    const comment = await this.commentRepo.findById(commentId);

    if (!comment) {
      throw new NotFoundAppException({}, 'comments');
    }

    const ability = await this.caslAbilityFactory.createForUser(principal);
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
    // Find the comment via repository
    const comment = await this.commentRepo.findById(commentId);

    if (!comment) {
      throw new NotFoundAppException({}, 'comments');
    }

    const ability = await this.caslAbilityFactory.createForUser(principal);
    if (!ability.can(CaslPermissionAction.DELETE, subject('Comment', comment))) {
      throw new ForbiddenAppException({}, 'comments');
    }

    // Delete the comment via repository
    await this.commentRepo.delete(commentId);
  }
}

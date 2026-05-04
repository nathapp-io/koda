import { Injectable, Inject } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { subject } from '@casl/ability';
import { CaslPermissionAction } from '@nathapp/nestjs-auth';
import { CommentType } from '../common/enums';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ValidationAppException, NotFoundAppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { CommentResponseDto } from './dto/comment-response.dto';
import { PrismaCommentRepository } from './prisma-comment.repository';
import { COMMENT_REPOSITORY } from './domain/comment.domain';
import { KodaPrincipal, isUserPrincipal } from '../auth/principal/koda-principal.types';
import { KodaCaslAbilityFactory } from '../auth/casl/koda-casl-ability.factory';

@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService<PrismaClient>,
    @Inject(COMMENT_REPOSITORY) private readonly commentRepo: PrismaCommentRepository,
    private readonly caslAbilityFactory: KodaCaslAbilityFactory,
  ) {}

  private get db() { return this.prisma.client; }


  async create(
    projectSlug: string,
    ticketRef: string,
    createCommentDto: CreateCommentDto,
    principal: KodaPrincipal,
  ) {
    // Validate required fields
    if (!createCommentDto.body) {
      throw new ValidationAppException({}, 'comments');
    }
    if (typeof createCommentDto.body === 'string' && createCommentDto.body.trim().length === 0) {
      throw new ValidationAppException({}, 'comments');
    }
    if (!createCommentDto.type) {
      throw new ValidationAppException({}, 'comments');
    }

    // Find project by slug
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'comments');
    }

    // Find ticket by ref (KODA-1 or CUID)
    const refPattern = /^([A-Z]+)-(\d+)$/;
    const match = ticketRef.match(refPattern);

    let ticket;

    if (match) {
      // Resolve by composite unique key (projectId, number)
      const number = parseInt(match[2], 10);
      ticket = await this.db.ticket.findUnique({
        where: {
          projectId_number: {
            projectId: project.id,
            number,
          },
        },
      });
    } else {
      // Treat as CUID
      ticket = await this.db.ticket.findUnique({
        where: { id: ticketRef },
      });
    }

    if (!ticket || ticket.deletedAt) {
      throw new NotFoundAppException({}, 'comments');
    }

    // Create the comment via repository.
    // id/createdAt/updatedAt are DB-generated; toPersistenceCreate strips them.
    const comment = await this.commentRepo.create({
      id: '',
      ticketId: ticket.id,
      body: createCommentDto.body,
      type: createCommentDto.type as CommentType,
      authorUserId: isUserPrincipal(principal) ? principal.id : null,
      authorAgentId: isUserPrincipal(principal) ? null : principal.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return CommentResponseDto.from(comment);
  }

  async findByTicket(projectSlug: string, ticketRef: string) {
    // Find project by slug
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'comments');
    }

    // Find ticket by ref (KODA-1 or CUID)
    const refPattern = /^([A-Z]+)-(\d+)$/;
    const match = ticketRef.match(refPattern);

    let ticket;

    if (match) {
      // Resolve by composite unique key (projectId, number)
      const number = parseInt(match[2], 10);
      ticket = await this.db.ticket.findUnique({
        where: {
          projectId_number: {
            projectId: project.id,
            number,
          },
        },
      });
    } else {
      // Treat as CUID
      ticket = await this.db.ticket.findUnique({
        where: { id: ticketRef },
      });
    }

    if (!ticket || ticket.deletedAt) {
      throw new NotFoundAppException({}, 'comments');
    }

    // Find all comments for this ticket via repository
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

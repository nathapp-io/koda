import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { CommentType } from '../common/enums';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ValidationAppException, NotFoundAppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';

interface CurrentUser {
  sub: string;
  role?: string;
}

@Injectable()
export class CommentsService {
  constructor(private prisma: PrismaService<PrismaClient>) {}
  private get db() { return this.prisma.client; }


  async create(
    projectSlug: string,
    ticketRef: string,
    createCommentDto: CreateCommentDto,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ) {
    // Validate required fields
    if (!createCommentDto.body) {
      throw new ValidationAppException();
    }
    if (typeof createCommentDto.body === 'string' && createCommentDto.body.trim().length === 0) {
      throw new ValidationAppException();
    }
    if (!createCommentDto.type) {
      throw new ValidationAppException();
    }

    // Find project by slug
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new NotFoundAppException();
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
      throw new NotFoundAppException();
    }

    // Create the comment
    const comment = await this.db.comment.create({
      data: {
        ticketId: ticket.id,
        body: createCommentDto.body,
        type: createCommentDto.type as CommentType,
        authorUserId: actorType === 'user' ? currentUser.sub : null,
        authorAgentId: actorType === 'agent' ? currentUser.sub : null,
      },
    });

    return comment;
  }

  async findByTicket(projectSlug: string, ticketRef: string) {
    // Find project by slug
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new NotFoundAppException();
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
      throw new NotFoundAppException();
    }

    // Find all comments for this ticket, ordered by creation date
    const comments = await this.db.comment.findMany({
      where: { ticketId: ticket.id },
      orderBy: { createdAt: 'asc' },
    });

    return comments;
  }

  async findById(id: string) {
    const comment = await this.db.comment.findUnique({
      where: { id },
    });

    return comment;
  }

  async update(
    commentId: string,
    updateCommentDto: UpdateCommentDto,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ) {
    // Find the comment
    const comment = await this.db.comment.findUnique({
      where: { id: commentId },
    });

    if (!comment) {
      throw new NotFoundAppException();
    }

    // Check authorization: only author or admin can edit
    const isAuthor =
      (actorType === 'user' && comment.authorUserId === currentUser.sub) ||
      (actorType === 'agent' && comment.authorAgentId === currentUser.sub);

    const isAdmin = actorType === 'user' && currentUser.role === 'ADMIN';

    if (!isAuthor && !isAdmin) {
      throw new ForbiddenAppException();
    }

    // Update the comment
    const updatedComment = await this.db.comment.update({
      where: { id: commentId },
      data: {
        body: updateCommentDto.body,
      },
    });

    return updatedComment;
  }

  async delete(
    commentId: string,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ) {
    // Find the comment
    const comment = await this.db.comment.findUnique({
      where: { id: commentId },
    });

    if (!comment) {
      throw new NotFoundAppException();
    }

    // Check authorization: only author or admin can delete
    const isAuthor =
      (actorType === 'user' && comment.authorUserId === currentUser.sub) ||
      (actorType === 'agent' && comment.authorAgentId === currentUser.sub);

    const isAdmin = actorType === 'user' && currentUser.role === 'ADMIN';

    if (!isAuthor && !isAdmin) {
      throw new ForbiddenAppException();
    }

    // Delete the comment
    await this.db.comment.delete({
      where: { id: commentId },
    });
  }
}

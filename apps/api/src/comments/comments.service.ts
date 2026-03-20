import { Injectable, HttpStatus } from '@nestjs/common';
import { CommentType, PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { AppException } from '../common/app-exception';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';

interface CurrentUser {
  sub: string;
  role?: string;
}

@Injectable()
export class CommentsService {
  constructor(private prisma: PrismaService<PrismaClient>) {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get db(): PrismaClient { return (this.prisma as any).client ?? (this.prisma as unknown as PrismaClient); }


  async create(
    projectSlug: string,
    ticketRef: string,
    createCommentDto: CreateCommentDto,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ) {
    // Validate required fields
    if (!createCommentDto.body) {
      throw new AppException('comments.bodyRequired', HttpStatus.BAD_REQUEST);
    }
    if (typeof createCommentDto.body === 'string' && createCommentDto.body.trim().length === 0) {
      throw new AppException('comments.bodyEmpty', HttpStatus.BAD_REQUEST);
    }
    if (!createCommentDto.type) {
      throw new AppException('comments.typeRequired', HttpStatus.BAD_REQUEST);
    }

    // Find project by slug
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new AppException('projects.notFound', HttpStatus.NOT_FOUND);
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
      throw new AppException('tickets.notFound', HttpStatus.NOT_FOUND);
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
      throw new AppException('projects.notFound', HttpStatus.NOT_FOUND);
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
      throw new AppException('tickets.notFound', HttpStatus.NOT_FOUND);
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
      throw new AppException('comments.notFound', HttpStatus.NOT_FOUND);
    }

    // Check authorization: only author or admin can edit
    const isAuthor =
      (actorType === 'user' && comment.authorUserId === currentUser.sub) ||
      (actorType === 'agent' && comment.authorAgentId === currentUser.sub);

    const isAdmin = actorType === 'user' && currentUser.role === 'ADMIN';

    if (!isAuthor && !isAdmin) {
      throw new AppException('errors.forbidden', HttpStatus.FORBIDDEN);
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
      throw new AppException('comments.notFound', HttpStatus.NOT_FOUND);
    }

    // Check authorization: only author or admin can delete
    const isAuthor =
      (actorType === 'user' && comment.authorUserId === currentUser.sub) ||
      (actorType === 'agent' && comment.authorAgentId === currentUser.sub);

    const isAdmin = actorType === 'user' && currentUser.role === 'ADMIN';

    if (!isAuthor && !isAdmin) {
      throw new AppException('errors.forbidden', HttpStatus.FORBIDDEN);
    }

    // Delete the comment
    await this.db.comment.delete({
      where: { id: commentId },
    });
  }
}

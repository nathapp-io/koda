import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { CommentType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';

interface CurrentUser {
  sub: string;
  role?: string;
}

@Injectable()
export class CommentsService {
  constructor(private prisma: PrismaService) {}

  async create(
    projectSlug: string,
    ticketRef: string,
    createCommentDto: CreateCommentDto,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ) {
    // Validate required fields
    if (!createCommentDto.body) {
      throw new BadRequestException('Body is required');
    }
    if (typeof createCommentDto.body === 'string' && createCommentDto.body.trim().length === 0) {
      throw new BadRequestException('Body must not be empty');
    }
    if (!createCommentDto.type) {
      throw new BadRequestException('Type is required');
    }

    // Find project by slug
    const project = await this.prisma.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new NotFoundException('Project not found');
    }

    // Find ticket by ref (KODA-1 or CUID)
    const refPattern = /^([A-Z]+)-(\d+)$/;
    const match = ticketRef.match(refPattern);

    let ticket;

    if (match) {
      // Resolve by composite unique key (projectId, number)
      const number = parseInt(match[2], 10);
      ticket = await this.prisma.ticket.findUnique({
        where: {
          projectId_number: {
            projectId: project.id,
            number,
          },
        },
      });
    } else {
      // Treat as CUID
      ticket = await this.prisma.ticket.findUnique({
        where: { id: ticketRef },
      });
    }

    if (!ticket || ticket.deletedAt) {
      throw new NotFoundException('Ticket not found');
    }

    // Create the comment
    const comment = await this.prisma.comment.create({
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
    const project = await this.prisma.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new NotFoundException('Project not found');
    }

    // Find ticket by ref (KODA-1 or CUID)
    const refPattern = /^([A-Z]+)-(\d+)$/;
    const match = ticketRef.match(refPattern);

    let ticket;

    if (match) {
      // Resolve by composite unique key (projectId, number)
      const number = parseInt(match[2], 10);
      ticket = await this.prisma.ticket.findUnique({
        where: {
          projectId_number: {
            projectId: project.id,
            number,
          },
        },
      });
    } else {
      // Treat as CUID
      ticket = await this.prisma.ticket.findUnique({
        where: { id: ticketRef },
      });
    }

    if (!ticket || ticket.deletedAt) {
      throw new NotFoundException('Ticket not found');
    }

    // Find all comments for this ticket, ordered by creation date
    const comments = await this.prisma.comment.findMany({
      where: { ticketId: ticket.id },
      orderBy: { createdAt: 'asc' },
    });

    return comments;
  }

  async findById(id: string) {
    const comment = await this.prisma.comment.findUnique({
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
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
    });

    if (!comment) {
      throw new NotFoundException('Comment not found');
    }

    // Check authorization: only author or admin can edit
    const isAuthor =
      (actorType === 'user' && comment.authorUserId === currentUser.sub) ||
      (actorType === 'agent' && comment.authorAgentId === currentUser.sub);

    const isAdmin = actorType === 'user' && currentUser.role === 'ADMIN';

    if (!isAuthor && !isAdmin) {
      throw new ForbiddenException('Only the comment author or an admin can edit this comment');
    }

    // Update the comment
    const updatedComment = await this.prisma.comment.update({
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
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
    });

    if (!comment) {
      throw new NotFoundException('Comment not found');
    }

    // Check authorization: only author or admin can delete
    const isAuthor =
      (actorType === 'user' && comment.authorUserId === currentUser.sub) ||
      (actorType === 'agent' && comment.authorAgentId === currentUser.sub);

    const isAdmin = actorType === 'user' && currentUser.role === 'ADMIN';

    if (!isAuthor && !isAdmin) {
      throw new ForbiddenException('Only the comment author or an admin can delete this comment');
    }

    // Delete the comment
    await this.prisma.comment.delete({
      where: { id: commentId },
    });
  }
}

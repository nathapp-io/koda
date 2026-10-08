import { Injectable } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';

export interface TicketForNotification {
  id: string;
  projectId: string;
  number: number;
  title: string;
  description: string | null;
  createdByUserId: string | null;
  deletedAt: Date | null;
  project: { key: string; slug: string };
}

export interface CommentForNotification {
  id: string;
  ticketId: string;
  body: string;
  authorUserId: string | null;
}

/** Fleet S4a §2.2: what the ticket producer reads. Comments are hard-deleted, so a missing row means deleted. */
@Injectable()
export class TicketNotificationReadsRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  findTicket(ticketId: string): Promise<TicketForNotification | null> {
    return this.db.ticket.findUnique({
      where: { id: ticketId },
      select: {
        id: true, projectId: true, number: true, title: true, description: true, createdByUserId: true, deletedAt: true,
        project: { select: { key: true, slug: true } },
      },
    });
  }

  findComment(commentId: string): Promise<CommentForNotification | null> {
    return this.db.comment.findUnique({ where: { id: commentId }, select: { id: true, ticketId: true, body: true, authorUserId: true } });
  }

  /** Display name for the kinds table: user name, else email local part; agent name. Never an email address. */
  async actorName(actorId: string, actorType: 'user' | 'agent'): Promise<string> {
    if (actorType === 'agent') {
      const agent = await this.db.agent.findUnique({ where: { id: actorId }, select: { name: true } });
      return agent?.name ?? 'An agent';
    }
    const user = await this.db.user.findUnique({ where: { id: actorId }, select: { name: true, email: true } });
    if (!user) return 'Someone';
    return user.name?.trim() || user.email.split('@')[0];
  }

  async isUser(id: string): Promise<boolean> {
    return (await this.db.user.count({ where: { id } })) === 1;
  }
}

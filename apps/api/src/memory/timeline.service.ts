import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';

export interface TimelineQuery {
  projectId: string;
  actorId?: string;
  ticketId?: string;
  eventTypes?: string[];
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
}

export interface TimelineEvent {
  id: string;
  eventType: string;
  actorId: string;
  action: string;
  ticketId?: string;
  createdAt: Date;
}

export interface TimelineResponse {
  events: TimelineEvent[];
  nextCursor?: string;
  total?: number;
}

export interface TicketHistoryResponse {
  events: TimelineEvent[];
  ticketId: string;
}

@Injectable()
export class TimelineService {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  async getProjectTimeline(query: TimelineQuery): Promise<TimelineResponse> {
    const limit = Math.min(query.limit ?? 50, 200);

    const where: {
      projectId: string;
      actorId?: string;
      ticketId?: string;
      createdAt?: { gte?: Date; lte?: Date };
    } = {
      projectId: query.projectId,
    };

    if (query.actorId) {
      where.actorId = query.actorId;
    }

    if (query.ticketId) {
      where.ticketId = query.ticketId;
    }

    if (query.from || query.to) {
      where.createdAt = {};
      if (query.from) {
        where.createdAt.gte = query.from;
      }
      if (query.to) {
        where.createdAt.lte = query.to;
      }
    }

    const events = await this.db.ticketEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });

    const hasMore = events.length > limit;
    const resultEvents = hasMore ? events.slice(0, limit) : events;

    return {
      events: resultEvents.map((e) => ({
        id: e.id,
        eventType: 'ticket_event',
        actorId: e.actorId,
        action: e.action,
        ticketId: e.ticketId,
        createdAt: e.createdAt,
      })),
      nextCursor: hasMore ? resultEvents[resultEvents.length - 1]?.id : undefined,
      total: hasMore ? events.length : resultEvents.length,
    };
  }

  async getTicketHistory(ticketId: string): Promise<TicketHistoryResponse> {
    const events = await this.db.ticketEvent.findMany({
      where: { ticketId },
      orderBy: { createdAt: 'desc' },
    });

    return {
      events: events.map((e) => ({
        id: e.id,
        eventType: 'ticket_event',
        actorId: e.actorId,
        action: e.action,
        ticketId: e.ticketId,
        createdAt: e.createdAt,
      })),
      ticketId,
    };
  }
}
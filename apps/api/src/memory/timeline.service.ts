import { Injectable } from '@nestjs/common';
import { ValidationAppException } from '@nathapp/nestjs-common';
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
    const limit = Math.min(Math.max(Math.floor(query.limit ?? 50), 1), 200);
    const eventTypes = query.eventTypes?.length
      ? query.eventTypes
      : ['ticket_event', 'agent_event', 'decision_event'];

    const allowedTypes = new Set(['ticket_event', 'agent_event', 'decision_event']);
    const unknownTypes = eventTypes.filter((eventType) => !allowedTypes.has(eventType));
    if (unknownTypes.length > 0) {
      throw new ValidationAppException({ eventTypes: `Unknown event types: ${unknownTypes.join(', ')}` });
    }

    const baseWhere = {
      projectId: query.projectId,
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    };

    const actorWhere = query.actorId ? { ...baseWhere, actorId: query.actorId } : baseWhere;
    const ticketWhere = query.ticketId ? { ...actorWhere, ticketId: query.ticketId } : actorWhere;
    const decisionWhere = query.actorId
      ? { ...baseWhere, agentId: query.actorId }
      : baseWhere;

    const results: TimelineEvent[] = [];

    if (eventTypes.includes('ticket_event')) {
      const ticketEvents = (await this.db.ticketEvent.findMany({
        where: ticketWhere,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      })) ?? [];
      results.push(...ticketEvents.map((e) => ({
        id: e.id,
        eventType: 'ticket_event',
        actorId: e.actorId,
        action: e.action,
        ticketId: e.ticketId,
        createdAt: e.createdAt,
      })));
    }

    if (!query.ticketId && eventTypes.includes('agent_event')) {
      const agentEvents = (await this.db.agentEvent.findMany({
        where: actorWhere,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      })) ?? [];
      results.push(...agentEvents.map((e) => ({
        id: e.id,
        eventType: 'agent_event',
        actorId: e.actorId,
        action: e.action,
        createdAt: e.createdAt,
      })));
    }

    if (!query.ticketId && eventTypes.includes('decision_event')) {
      const decisionEvents = (await this.db.decisionEvent.findMany({
        where: decisionWhere,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      })) ?? [];
      results.push(...decisionEvents.map((e) => ({
        id: e.id,
        eventType: 'decision_event',
        actorId: e.agentId,
        action: e.action,
        createdAt: e.createdAt,
      })));
    }

    results.sort((left, right) => {
      const timeDelta = right.createdAt.getTime() - left.createdAt.getTime();
      if (timeDelta !== 0) return timeDelta;
      return right.id.localeCompare(left.id);
    });

    const total = results.length;

    if (query.cursor) {
      const cursorIndex = results.findIndex((event) => event.id === query.cursor);
      if (cursorIndex < 0) {
        throw new ValidationAppException({ cursor: 'Unknown cursor' });
      }
      results.splice(0, cursorIndex + 1);
    }

    const slicedEvents = results.slice(0, limit);
    const hasMore = results.length > limit;

    return {
      events: slicedEvents,
      nextCursor: hasMore ? slicedEvents[slicedEvents.length - 1]?.id : undefined,
      total,
    };
  }

  async getTicketHistory(ticketId: string): Promise<TicketHistoryResponse> {
    const events = (await this.db.ticketEvent.findMany({
      where: { ticketId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })) ?? [];

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

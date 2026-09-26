import { Injectable } from '@nestjs/common';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { PrismaTimelineRepository } from './prisma-timeline.repository';
import { compareEventsDesc } from './event-order';
import { decodeTimelineCursor, encodeTimelineCursor, TimelineKey } from './timeline-cursor';

export const DEFAULT_TIMELINE_LIMIT = 50;
export const MAX_TIMELINE_LIMIT = 100;
const TIMELINE_EVENT_TYPES = ['ticket_event', 'agent_event', 'decision_event'] as const;
type TimelineEventType = (typeof TIMELINE_EVENT_TYPES)[number];

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
}

export interface TicketHistoryResponse {
  events: TimelineEvent[];
  ticketId: string;
}

@Injectable()
export class TimelineService {
  constructor(private readonly timelineRepo: PrismaTimelineRepository) {}

  async getProjectTimeline(query: TimelineQuery): Promise<TimelineResponse> {
    const limit = query.limit ?? DEFAULT_TIMELINE_LIMIT;
    const eventTypes = query.eventTypes?.length ? query.eventTypes : [...TIMELINE_EVENT_TYPES];

    const unknownTypes = eventTypes.filter((eventType) => !TIMELINE_EVENT_TYPES.includes(eventType as TimelineEventType));
    if (unknownTypes.length > 0) {
      throw new ValidationAppException({ eventTypes: `Unknown event types: ${unknownTypes.join(', ')}` });
    }

    let cursor: TimelineKey | undefined;
    if (query.cursor !== undefined) {
      const decoded = decodeTimelineCursor(query.cursor);
      if (!decoded) {
        throw new ValidationAppException({ cursor: 'Invalid cursor' });
      }
      cursor = decoded;
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

    // Each table returns at most limit + 1 rows past the cursor; the merged
    // top `limit` is exact because every table is individually sorted the same way.
    const page = { cursor, take: limit + 1 };
    const results: TimelineEvent[] = [];

    if (eventTypes.includes('ticket_event')) {
      const rows = (await this.timelineRepo.findTicketEvents(ticketWhere, page)) ?? [];
      results.push(...rows.map((e) => ({
        id: e.id,
        eventType: 'ticket_event',
        actorId: e.actorId,
        action: e.action,
        ticketId: e.ticketId ?? undefined,
        createdAt: e.createdAt,
      })));
    }

    if (!query.ticketId && eventTypes.includes('agent_event')) {
      const rows = (await this.timelineRepo.findAgentEvents(actorWhere, page)) ?? [];
      results.push(...rows.map((e) => ({
        id: e.id,
        eventType: 'agent_event',
        actorId: e.actorId,
        action: e.action,
        createdAt: e.createdAt,
      })));
    }

    if (!query.ticketId && eventTypes.includes('decision_event')) {
      const rows = (await this.timelineRepo.findDecisionEvents(decisionWhere, page)) ?? [];
      results.push(...rows.map((e) => ({
        id: e.id,
        eventType: 'decision_event',
        actorId: e.agentId,
        action: e.action,
        createdAt: e.createdAt,
      })));
    }

    results.sort(compareEventsDesc);
    const events = results.slice(0, limit);
    const last = events[events.length - 1];

    return {
      events,
      nextCursor: results.length > limit && last ? encodeTimelineCursor(last) : undefined,
    };
  }

  async getTicketHistory(ticketId: string): Promise<TicketHistoryResponse> {
    const events = (await this.timelineRepo.findTicketEvents({ ticketId })) ?? [];

    return {
      events: events.map((e) => ({
        id: e.id,
        eventType: 'ticket_event',
        actorId: e.actorId,
        action: e.action,
        ticketId: e.ticketId ?? undefined,
        createdAt: e.createdAt,
      })),
      ticketId,
    };
  }
}

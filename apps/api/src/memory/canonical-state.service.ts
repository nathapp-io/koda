import { Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';

export interface CanonicalSnapshotQuery {
  projectId: string;
  ticketIds?: string[];
  actorId?: string;
  timeWindow?: { from?: Date; to?: Date };
}

export interface CanonicalTicket {
  id: string;
  title: string;
  status: string;
  priority: string;
  assignedToUserId: string | null;
  assignedToAgentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CanonicalEvent {
  id: string;
  eventType: string;
  actorId: string;
  action: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface CanonicalDecision {
  id: string;
  topic: string;
  decision: string;
  rationale: string | null;
  createdAt: Date;
}

export interface CanonicalSnapshot {
  tickets: CanonicalTicket[];
  recentEvents: CanonicalEvent[];
  activeDecisions: CanonicalDecision[];
  retrievedAt: Date;
}

@Injectable()
export class CanonicalStateService {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  async getSnapshot(query: CanonicalSnapshotQuery): Promise<CanonicalSnapshot> {
    const retrievedAt = new Date();

    const project = await this.db.project.findUnique({
      where: { id: query.projectId },
    });

    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'memory');
    }

    const tickets = await this.loadTickets(query);
    const recentEvents = await this.loadEvents(query);
    const activeDecisions = await this.loadActiveDecisions(query.projectId);

    return {
      tickets,
      recentEvents,
      activeDecisions,
      retrievedAt,
    };
  }

  private async loadTickets(
    query: CanonicalSnapshotQuery,
  ): Promise<CanonicalTicket[]> {
    if (!query.ticketIds || query.ticketIds.length === 0) {
      return [];
    }

    const rows = await this.db.ticket.findMany({
      where: {
        projectId: query.projectId,
        id: { in: query.ticketIds },
        deletedAt: null,
      },
      select: {
        id: true,
        title: true,
        status: true,
        priority: true,
        assignedToUserId: true,
        assignedToAgentId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return rows as CanonicalTicket[];
  }

  private async loadEvents(
    query: CanonicalSnapshotQuery,
  ): Promise<CanonicalEvent[]> {
    if (!query.timeWindow) {
      return [];
    }

    const { from, to } = query.timeWindow;

    const baseWhere = {
      projectId: query.projectId,
      createdAt: {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      },
    };

    const actorWhere = query.actorId
      ? { ...baseWhere, actorId: query.actorId }
      : baseWhere;
    const decisionWhere = query.actorId
      ? { ...baseWhere, agentId: query.actorId }
      : baseWhere;

    const [ticketRows, agentRows, decisionRows] = await Promise.all([
      this.db.ticketEvent.findMany({
        where: actorWhere,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.db.agentEvent.findMany({
        where: actorWhere,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.db.decisionEvent.findMany({
        where: decisionWhere,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]);

    const events: CanonicalEvent[] = [];

    for (const e of ticketRows) {
      events.push({
        id: e.id,
        eventType: 'ticket_event',
        actorId: e.actorId,
        action: e.action,
        payload: parsePayload(e.data),
        createdAt: e.createdAt,
      });
    }

    for (const e of agentRows) {
      events.push({
        id: e.id,
        eventType: 'agent_event',
        actorId: e.actorId,
        action: e.action,
        payload: parsePayload(e.data),
        createdAt: e.createdAt,
      });
    }

    for (const e of decisionRows) {
      events.push({
        id: e.id,
        eventType: 'decision_event',
        actorId: e.agentId,
        action: e.action,
        payload: parsePayload(e.data),
        createdAt: e.createdAt,
      });
    }

    events.sort((a, b) => {
      const timeDelta = b.createdAt.getTime() - a.createdAt.getTime();
      if (timeDelta !== 0) return timeDelta;
      return b.id.localeCompare(a.id);
    });

    return events;
  }

  private async loadActiveDecisions(
    projectId: string,
  ): Promise<CanonicalDecision[]> {
    const rows = await this.db.memoryItem.findMany({
      where: {
        projectId,
        kind: 'DECISION',
        status: 'active',
        deletedAt: null,
      },
      select: {
        id: true,
        predicate: true,
        object: true,
        createdAt: true,
      },
    });

    return rows.map((row) => ({
      id: row.id,
      topic: row.predicate,
      decision: row.object ?? '',
      rationale: null,
      createdAt: row.createdAt,
    }));
  }
}

function parsePayload(data: string): Record<string, unknown> {
  try {
    return JSON.parse(data);
  } catch {
    return {};
  }
}

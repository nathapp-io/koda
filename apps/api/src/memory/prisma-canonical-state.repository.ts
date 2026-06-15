import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';
import type { ICanonicalStateRepository } from './domain/canonical-state.domain';
import type {
  CanonicalDecision,
  CanonicalEvent,
  CanonicalSnapshotQuery,
  CanonicalTicket,
} from './canonical-state.service';

@Injectable()
export class PrismaCanonicalStateRepository implements ICanonicalStateRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  async findProject(projectId: string): Promise<{ id: string; deletedAt: Date | null } | null> {
    return this.db.project.findUnique({ where: { id: projectId } });
  }

  async findTickets(query: CanonicalSnapshotQuery): Promise<CanonicalTicket[]> {
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

  async findEvents(query: CanonicalSnapshotQuery): Promise<CanonicalEvent[]> {
    const { from, to } = query.timeWindow ?? {};

    if (!query.timeWindow && !query.actorId) {
      return [];
    }

    const createdAtFilter: Record<string, unknown> = {};
    if (from) createdAtFilter.gte = from;
    if (to) createdAtFilter.lte = to;

    const baseWhere: Record<string, unknown> = {
      projectId: query.projectId,
      ...(Object.keys(createdAtFilter).length > 0 ? { createdAt: createdAtFilter } : {}),
    };

    const actorWhere = query.actorId ? { ...baseWhere, actorId: query.actorId } : baseWhere;
    const decisionWhere = query.actorId ? { ...baseWhere, agentId: query.actorId } : baseWhere;

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
        rationale: null,
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
        rationale: null,
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
        rationale: e.rationale,
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

  async findActiveDecisions(projectId: string): Promise<CanonicalDecision[]> {
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

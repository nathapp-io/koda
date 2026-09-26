import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';
import { keysetWhere, TimelineKey } from './timeline-cursor';

export interface KeysetPage {
  cursor?: TimelineKey;
  take: number;
}

const NEWEST_FIRST = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

export interface TicketEventRow {
  id: string;
  actorId: string;
  action: string;
  ticketId: string | null;
  createdAt: Date;
}

export interface AgentEventRow {
  id: string;
  actorId: string;
  action: string;
  createdAt: Date;
}

export interface DecisionEventRow {
  id: string;
  agentId: string;
  action: string;
  createdAt: Date;
}

@Injectable()
export class PrismaTimelineRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async findTicketEvents(where: Record<string, unknown>, page?: KeysetPage): Promise<TicketEventRow[]> {
    return this.prisma.client.ticketEvent.findMany({
      where: keysetWhere(where, page?.cursor),
      orderBy: NEWEST_FIRST,
      ...(page && { take: page.take }),
    });
  }

  async findAgentEvents(where: Record<string, unknown>, page?: KeysetPage): Promise<AgentEventRow[]> {
    return this.prisma.client.agentEvent.findMany({
      where: keysetWhere(where, page?.cursor),
      orderBy: NEWEST_FIRST,
      ...(page && { take: page.take }),
    });
  }

  async findDecisionEvents(where: Record<string, unknown>, page?: KeysetPage): Promise<DecisionEventRow[]> {
    return this.prisma.client.decisionEvent.findMany({
      where: keysetWhere(where, page?.cursor),
      orderBy: NEWEST_FIRST,
      ...(page && { take: page.take }),
    });
  }
}

import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';

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

  async findTicketEvents(where: Record<string, unknown>): Promise<TicketEventRow[]> {
    return this.prisma.client.ticketEvent.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  async findAgentEvents(where: Record<string, unknown>): Promise<AgentEventRow[]> {
    return this.prisma.client.agentEvent.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  async findDecisionEvents(where: Record<string, unknown>): Promise<DecisionEventRow[]> {
    return this.prisma.client.decisionEvent.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }
}

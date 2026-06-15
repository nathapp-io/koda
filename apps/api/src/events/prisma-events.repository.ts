import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';
import type { WriteAgentActionInput, WriteTicketEventInput } from '../koda-domain-writer/write-result.dto';
import type { CreateDecisionEventInput } from './decision-event.service';
import type { AgentEventDomain, DecisionEventDomain, TicketEventDomain } from './domain/events.domain';

@Injectable()
export class PrismaEventsRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async findProject(projectId: string): Promise<{ id: string } | null> {
    return this.prisma.client.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });
  }

  async createAgentEvent(data: WriteAgentActionInput): Promise<AgentEventDomain> {
    return this.prisma.client.agentEvent.create({
      data: {
        agentId: data.agentId,
        projectId: data.projectId,
        action: data.action,
        actorId: data.actorId,
        source: data.source,
        data: JSON.stringify(data.data),
        timestamp: new Date(),
      },
    });
  }

  async createDecisionEvent(data: CreateDecisionEventInput): Promise<DecisionEventDomain> {
    return this.prisma.client.decisionEvent.create({
      data: {
        projectId: data.projectId,
        agentId: data.agentId,
        action: data.action,
        decision: data.decision,
        rationale: data.rationale,
        source: data.source,
        data: JSON.stringify(data.data),
        timestamp: new Date(),
      },
    });
  }

  async createTicketEvent(data: WriteTicketEventInput): Promise<TicketEventDomain> {
    const dataValue = typeof data.data === 'string' ? data.data : JSON.stringify(data.data);
    return this.prisma.client.ticketEvent.create({
      data: {
        ticketId: data.ticketId,
        projectId: data.projectId,
        action: data.action,
        actorId: data.actorId,
        actorType: data.actorType,
        source: data.source,
        data: dataValue,
        timestamp: new Date(),
      },
    });
  }
}

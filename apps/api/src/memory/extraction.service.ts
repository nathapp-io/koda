import { Injectable } from '@nestjs/common';
import { MemoryKind } from '../common/enums';

export interface MemoryExtractedItem {
  projectId: string;
  kind: MemoryKind;
  subject: string;
  predicate: string;
  object?: string;
  sourceType?: string;
  sourceId?: string;
  confidence: number;
  ttlAt?: Date;
}

interface TicketEvent {
  type: 'ticket_event';
  id: string;
  ticketId?: string;
  projectId: string;
  actorId: string;
  action: string;
  data: unknown;
  timestamp: Date;
}

interface AgentEvent {
  type: 'agent_event';
  id: string;
  agentId: string;
  projectId: string;
  actorId: string;
  action: string;
  data: unknown;
  timestamp: Date;
}

interface DecisionEvent {
  type: 'decision_event';
  id: string;
  agentId: string;
  projectId: string;
  actorId: string;
  action: string;
  decision: string;
  data: unknown;
  timestamp: Date;
}

type CanonicalEvent = TicketEvent | AgentEvent | DecisionEvent;

export interface WriteResult {
  canonicalId: string;
  memoryId: string;
}

interface MemoryItemRepository {
  upsert(item: unknown): Promise<unknown>;
  findActive(projectId: string, kind: string, subject: string, predicate: string): Promise<unknown | null>;
}

@Injectable()
export class ExtractionService {
  extractFromEvent(event: CanonicalEvent): MemoryExtractedItem[] {
    if (event.type === 'ticket_event') {
      return this.extractTicketEvent(event as TicketEvent);
    }
    if (event.type === 'agent_event') {
      return this.extractAgentEvent(event as AgentEvent);
    }
    if (event.type === 'decision_event') {
      return this.extractDecisionEvent(event as DecisionEvent);
    }
    return [];
  }

  private extractTicketEvent(event: TicketEvent): MemoryExtractedItem[] {
    if (!event.ticketId || !event.projectId) {
      return [];
    }

    if (event.action === 'status_changed') {
      const data = typeof event.data === 'string' ? JSON.parse(event.data as string) : event.data;
      return [
        {
          projectId: event.projectId,
          kind: MemoryKind.FACT,
          subject: `ticket:${event.ticketId}`,
          predicate: 'status',
          object: (data as { newStatus?: string; status?: string }).newStatus || (data as { status?: string }).status,
          confidence: 0.9,
        },
      ];
    }

    if (event.action === 'assigned') {
      const data = typeof event.data === 'string' ? JSON.parse(event.data as string) : event.data;
      return [
        {
          projectId: event.projectId,
          kind: MemoryKind.FACT,
          subject: `ticket:${event.ticketId}`,
          predicate: 'assigned_to',
          object: (data as { assignedTo?: string }).assignedTo,
          confidence: 0.85,
        },
      ];
    }

    if (event.action === 'incident_linked') {
      const data = typeof event.data === 'string' ? JSON.parse(event.data as string) : event.data;
      return [
        {
          projectId: event.projectId,
          kind: MemoryKind.INCIDENT_PATTERN,
          subject: `ticket:${event.ticketId}`,
          predicate: 'incident',
          object: (data as { incidentId?: string }).incidentId,
          confidence: 0.75,
        },
      ];
    }

    return [];
  }

  private extractAgentEvent(event: AgentEvent): MemoryExtractedItem[] {
    if (!event.projectId) {
      return [];
    }

    if (event.action === 'decision_made') {
      const data = typeof event.data === 'string' ? JSON.parse(event.data as string) : event.data;
      const decisionData = data as { decision?: string; rationale?: string };
      return [
        {
          projectId: event.projectId,
          kind: MemoryKind.DECISION,
          subject: `agent:${event.agentId}`,
          predicate: 'decision',
          object: decisionData.decision,
          confidence: 0.95,
        },
      ];
    }

    return [];
  }

  private extractDecisionEvent(event: DecisionEvent): MemoryExtractedItem[] {
    if (!event.projectId) {
      return [];
    }

    return [
      {
        projectId: event.projectId,
        kind: MemoryKind.DECISION,
        subject: `agent:${event.agentId}`,
        predicate: 'decision',
        object: event.decision,
        sourceType: 'DecisionEvent',
        sourceId: event.id,
        confidence: 1.0,
      },
    ];
  }

  async recordDecision(
    decision: { projectId: string; agentId: string; decision: string; rationale?: string },
    _event: { id: string },
    repository: MemoryItemRepository,
    existingDecision?: { id: string },
  ): Promise<WriteResult> {
    const memoryId = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    if (existingDecision) {
      await repository.upsert({
        id: existingDecision.id,
        status: 'superseded',
        activeKey: null,
        supersededBy: memoryId,
      });
    }

    await repository.upsert({
      id: memoryId,
      projectId: decision.projectId,
      kind: MemoryKind.DECISION,
      subject: `agent:${decision.agentId}`,
      predicate: 'decision',
      object: decision.decision,
      activeKey: memoryId,
      status: 'active',
      confidence: 1.0,
    });

    return { canonicalId: memoryId, memoryId };
  }
}
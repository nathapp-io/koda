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
    if (!event.projectId) {
      return [];
    }

    if (!event.ticketId) {
      console.warn(`Incomplete ticket_event payload: missing ticketId, event id: ${event.id}`);
      return [];
    }

    if (event.action === 'status_changed') {
      let data: { newStatus?: string; status?: string } = {};
      try {
        data = typeof event.data === 'string' ? JSON.parse(event.data) : (event.data as typeof data);
      } catch {
        return [];
      }
      return [
        {
          projectId: event.projectId,
          kind: MemoryKind.FACT,
          subject: `ticket:${event.ticketId}`,
          predicate: 'status',
          object: data.newStatus || data.status,
          confidence: 0.9,
          ttlAt: null,
        },
      ];
    }

    if (event.action === 'assigned') {
      let data: { assignedTo?: string } = {};
      try {
        data = typeof event.data === 'string' ? JSON.parse(event.data) : (event.data as typeof data);
      } catch {
        return [];
      }
      return [
        {
          projectId: event.projectId,
          kind: MemoryKind.FACT,
          subject: `ticket:${event.ticketId}`,
          predicate: 'assigned_to',
          object: data.assignedTo,
          confidence: 0.85,
          ttlAt: null,
        },
      ];
    }

    if (event.action === 'incident_linked') {
      let data: { incidentId?: string } = {};
      try {
        data = typeof event.data === 'string' ? JSON.parse(event.data) : (event.data as typeof data);
      } catch {
        return [];
      }
      return [
        {
          projectId: event.projectId,
          kind: MemoryKind.INCIDENT_PATTERN,
          subject: `ticket:${event.ticketId}`,
          predicate: 'incident',
          object: data.incidentId,
          confidence: 0.75,
          ttlAt: null,
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
      let data: { decision?: string; rationale?: string } = {};
      try {
        data = typeof event.data === 'string' ? JSON.parse(event.data) : (event.data as typeof data);
      } catch {
        return [];
      }
      return [
        {
          projectId: event.projectId,
          kind: MemoryKind.DECISION,
          subject: `agent:${event.agentId}`,
          predicate: 'decision',
          object: data.decision,
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
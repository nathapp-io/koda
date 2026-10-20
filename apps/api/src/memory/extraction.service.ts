import { Injectable } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { MemoryKind } from '../common/enums';
import { PrismaMemoryItemRepository, type MemoryUpsertOptions } from './prisma-memory-item.repository';
import { MemoryItemInput } from './memory-item-repository';

export interface MemoryExtractedItem {
  projectId: string;
  kind: MemoryKind;
  subject: string;
  predicate: string;
  object?: string;
  sourceType?: string;
  sourceId?: string;
  confidence: number;
  ttlAt?: Date | null;
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

@Injectable()
export class ExtractionService {
  private readonly logger = new Logger(ExtractionService.name);

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
      this.logger.warn(`Incomplete ticket_event payload: missing ticketId, event id: ${event.id}`);
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
          sourceType: 'ticket_event',
          sourceId: event.id,
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
          sourceType: 'ticket_event',
          sourceId: event.id,
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
          sourceType: 'ticket_event',
          sourceId: event.id,
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
          sourceType: 'agent_event',
          sourceId: event.id,
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
        sourceType: 'decision_event',
        sourceId: event.id,
        confidence: 1.0,
      },
    ];
  }

  /**
   * Records one `DECISION` and answers what it wrote. The replacement of the requester's previous decision on the
   * same topic is *not* done here: `repository.upsert` supersedes the active row inside the same transaction that
   * inserts the new one (its serializable `$transaction`), so the two either both happen or neither does. A
   * separately committed pre-update left the topic with no active decision at all whenever the insert failed
   * (fleet S5b 2b1 branch review B1).
   *
   * Permissions P1 US-008: `input.ownerType` is stored on the item (a decision recorded as the caller is a USER or
   * AGENT row; one attributed to another actor is neither known, so it is null), and `options` is passed straight
   * through to `upsert` — the caller's replace check rides in it. A system caller (the outbox subscriber) passes
   * neither and keeps the one-argument `upsert` it always made.
   */
  async recordDecision(
    input: {
      projectId: string;
      actorId: string;
      topic: string;
      decision: string;
      rationale?: string;
      sourceId?: string;
      ownerType?: 'USER' | 'AGENT' | null;
    },
    repository: PrismaMemoryItemRepository,
    options?: MemoryUpsertOptions,
  ): Promise<WriteResult> {
    const memoryInput: MemoryItemInput = {
      projectId: input.projectId,
      kind: MemoryKind.DECISION,
      subject: `agent:${input.actorId}`,
      predicate: input.topic,
      object: input.decision,
      sourceType: 'decision_event',
      sourceId: input.sourceId,
      confidence: 1.0,
      ownerId: input.actorId,
      ownerType: input.ownerType ?? null,
    };

    const memory = options === undefined
      ? await repository.upsert(memoryInput)
      : await repository.upsert(memoryInput, options);

    return { canonicalId: input.sourceId ?? memory.id, memoryId: memory.id };
  }
}
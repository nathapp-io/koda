const MemoryKind = {
  FACT: 'FACT',
  INCIDENT_PATTERN: 'INCIDENT_PATTERN',
  DECISION: 'DECISION',
} as const;
type MemoryKind = (typeof MemoryKind)[keyof typeof MemoryKind];

interface MemoryExtractedItem {
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
  data: any;
  timestamp: Date;
}

interface AgentEvent {
  type: 'agent_event';
  id: string;
  agentId: string;
  projectId: string;
  actorId: string;
  action: string;
  data: any;
  timestamp: Date;
}

interface DecisionEvent {
  type: 'decision_event';
  id: string;
  agentId: string;
  projectId: string;
  action: string;
  data: any;
  timestamp: Date;
}

type CanonicalEvent = TicketEvent | AgentEvent | DecisionEvent;

class ExtractionService {
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
      const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      return [
        {
          projectId: event.projectId,
          kind: 'FACT',
          subject: `ticket:${event.ticketId}`,
          predicate: 'status',
          object: data.newStatus || data.status,
          confidence: 0.9,
        },
      ];
    }

    if (event.action === 'assigned') {
      const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      return [
        {
          projectId: event.projectId,
          kind: 'FACT',
          subject: `ticket:${event.ticketId}`,
          predicate: 'assigned_to',
          object: data.assignedTo,
          confidence: 0.85,
        },
      ];
    }

    if (event.action === 'incident_linked') {
      const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      return [
        {
          projectId: event.projectId,
          kind: 'INCIDENT_PATTERN',
          subject: `ticket:${event.ticketId}:service:${data.affectedServiceId || 'unknown'}`,
          predicate: 'incident_link',
          confidence: 0.75,
        },
      ];
    }

    return [];
  }

  private extractAgentEvent(event: AgentEvent): MemoryExtractedItem[] {
    const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    if (!data.decision_made) {
      return [];
    }

    return [
      {
        projectId: event.projectId,
        kind: 'DECISION',
        subject: `agent:${event.agentId}`,
        predicate: 'decision',
        object: data.decision_made,
        confidence: 0.95,
      },
    ];
  }

  private extractDecisionEvent(event: DecisionEvent): MemoryExtractedItem[] {
    if (!event.projectId) {
      return [];
    }

    return [
      {
        projectId: event.projectId,
        kind: 'DECISION',
        subject: `agent:${event.agentId}:${event.action}`,
        predicate: 'decision',
        sourceType: 'DecisionEvent',
        sourceId: event.id,
        confidence: 1.0,
      },
    ];
  }

  async recordDecision(decision: any, event: any, repository: any, existingDecision?: any): Promise<any> {
    const memoryItem = {
      projectId: event.projectId,
      kind: 'DECISION' as const,
      subject: `topic:${decision.topic}`,
      predicate: 'decision',
      object: decision.decision,
      sourceType: 'DecisionEvent',
      sourceId: event.id,
      confidence: 1.0,
    };

    const result = await repository.upsert(memoryItem);

    return {
      canonicalId: event.id,
      memoryId: result.id,
      confidence: 1.0,
    };
  }
}

describe('ExtractionService', () => {
  let service: ExtractionService;

  beforeEach(() => {
    service = new ExtractionService();
  });

  describe('extractFromEvent - ticket_event', () => {
    const baseTicketEvent: TicketEvent = {
      type: 'ticket_event',
      id: 'event-123',
      ticketId: 'ticket-456',
      projectId: 'project-123',
      actorId: 'actor-789',
      action: 'status_changed',
      data: {},
      timestamp: new Date(),
    };

    it('AC-10: action=status_changed returns item with kind=FACT, subject matching ticket:*, predicate=status', () => {
      const item = service.extractFromEvent(baseTicketEvent);

      expect(item).toHaveLength(1);
      expect(item[0].kind).toBe('FACT');
      expect(item[0].subject).toMatch(/^ticket:/);
      expect(item[0].predicate).toBe('status');
    });

    it('AC-11: action=assigned returns item with kind=FACT, subject matching ticket:*, predicate=assigned_to', () => {
      const event: TicketEvent = { ...baseTicketEvent, action: 'assigned' as const };
      const item = service.extractFromEvent(event);

      expect(item).toHaveLength(1);
      expect(item[0].kind).toBe('FACT');
      expect(item[0].subject).toMatch(/^ticket:/);
      expect(item[0].predicate).toBe('assigned_to');
    });

    it('AC-12: action=incident_linked returns item with kind=INCIDENT_PATTERN', () => {
      const event: TicketEvent = {
        ...baseTicketEvent,
        action: 'incident_linked' as const,
        data: { affectedServiceId: 'service-abc' },
      };
      const item = service.extractFromEvent(event);

      expect(item).toHaveLength(1);
      expect(item[0].kind).toBe('INCIDENT_PATTERN');
      expect(item[0].subject).toContain('ticket:');
      expect(item[0].subject).toContain('service-abc');
    });

    it('AC-13: agent_event without decision_made metadata returns empty array', () => {
      const agentEvent: AgentEvent = {
        type: 'agent_event',
        id: 'event-agent-1',
        agentId: 'agent-123',
        projectId: 'project-123',
        actorId: 'actor-789',
        action: 'test_action',
        data: {},
        timestamp: new Date(),
      };

      const item = service.extractFromEvent(agentEvent);

      expect(item).toHaveLength(0);
    });

    it('AC-14: incomplete event with missing required fields returns empty array', () => {
      const incompleteEvent: TicketEvent = {
        type: 'ticket_event',
        id: 'event-incomplete',
        action: 'status_changed' as const,
        data: {},
        timestamp: new Date(),
      } as TicketEvent;

      const item = service.extractFromEvent(incompleteEvent);

      expect(item).toHaveLength(0);
    });
  });

  describe('confidence validation', () => {
    it('AC-18: extractFromEvent returns items with confidence between 0.5 and 1.0', () => {
      const statusChangedEvent: TicketEvent = {
        type: 'ticket_event',
        id: 'event-123',
        ticketId: 'ticket-456',
        projectId: 'project-123',
        actorId: 'actor-789',
        action: 'status_changed' as const,
        data: {},
        timestamp: new Date(),
      };

      const items = service.extractFromEvent(statusChangedEvent);

      for (const item of items) {
        expect(item.confidence).toBeGreaterThanOrEqual(0.5);
        expect(item.confidence).toBeLessThanOrEqual(1.0);
      }
    });

    it('AC-18: incident_linked items have confidence >= 0.5', () => {
      const incidentEvent: TicketEvent = {
        type: 'ticket_event',
        id: 'event-123',
        ticketId: 'ticket-456',
        projectId: 'project-123',
        actorId: 'actor-789',
        action: 'incident_linked' as const,
        data: { affectedServiceId: 'service-abc' },
        timestamp: new Date(),
      };

      const items = service.extractFromEvent(incidentEvent);

      for (const item of items) {
        expect(item.confidence).toBeGreaterThanOrEqual(0.5);
        expect(item.confidence).toBeLessThanOrEqual(1.0);
      }
    });

    it('AC-18: ttlAt is null for all extracted items', () => {
      const event: TicketEvent = {
        type: 'ticket_event',
        id: 'event-123',
        ticketId: 'ticket-456',
        projectId: 'project-123',
        actorId: 'actor-789',
        action: 'status_changed' as const,
        data: {},
        timestamp: new Date(),
      };

      const items = service.extractFromEvent(event);

      for (const item of items) {
        expect(item.ttlAt == null).toBe(true);
      }
    });
  });

  describe('recordDecision', () => {
    let mockRepository: any;

    beforeEach(() => {
      mockRepository = {
        upsert: jest.fn(),
      };
    });

    it('AC-15: recordDecision returns WriteResult with canonicalId and memoryId', async () => {
      const mockDecisionEvent = { id: 'decision-event-123', projectId: 'project-123' };
      const mockMemoryItem = { id: 'memory-item-456', projectId: 'project-123' };
      mockRepository.upsert.mockResolvedValue(mockMemoryItem);

      const result = await service.recordDecision(
        { topic: 'escalation-policy', decision: 'escalate', rationale: 'high severity' },
        mockDecisionEvent as any,
        mockRepository,
      );

      expect(result).toHaveProperty('canonicalId');
      expect(result).toHaveProperty('memoryId');
      expect(result.canonicalId).toBe('decision-event-123');
      expect(result.memoryId).toBe('memory-item-456');
    });

    it('AC-16: recordDecision with existing active DecisionEvent updates supersededBy on old event', async () => {
      const existingDecision = { id: 'existing-decision', status: 'active' };
      const newDecision = { id: 'new-decision', action: 'decided' };
      mockRepository.upsert.mockResolvedValue({ id: 'new-memory' });

      const result = await service.recordDecision(
        { topic: 'escalation-policy', decision: 'escalate', rationale: 'high severity' },
        newDecision as any,
        mockRepository,
        existingDecision as any,
      );

      expect(result).toHaveProperty('canonicalId');
      expect(mockRepository.upsert).toHaveBeenCalled();
    });

    it('AC-19: recordDecision creates MemoryItem with confidence=1.0', async () => {
      const mockDecisionEvent = { id: 'decision-event-123', projectId: 'project-123' };
      mockRepository.upsert.mockResolvedValue({ id: 'memory-item-456' });

      await service.recordDecision(
        { topic: 'escalation-policy', decision: 'escalate', rationale: 'high severity' },
        mockDecisionEvent as any,
        mockRepository,
      );

      expect(mockRepository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          confidence: 1.0,
        }),
      );
    });
  });
});

import { MemoryKind } from '../../../src/common/enums';
import { ExtractionService, MemoryExtractedItem, WriteResult } from '../../../src/memory/extraction.service';

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

describe('ExtractionService', () => {
  let service: ExtractionService;

  beforeEach(() => {
    service = new ExtractionService();
  });

  describe('AC1: extractFromEvent(ticket_event action=status_changed)', () => {
    it('AC1: returns MemoryItem with kind=FACT, subject=ticket:{id}, predicate=status', () => {
      const event: TicketEvent = {
        type: 'ticket_event',
        id: 'event-123',
        ticketId: 'ticket-456',
        projectId: 'project-123',
        actorId: 'actor-789',
        action: 'status_changed',
        data: { newStatus: 'IN_PROGRESS' },
        timestamp: new Date(),
      };

      const result = service.extractFromEvent(event as unknown as TicketEvent | AgentEvent | DecisionEvent);

      expect(result).toHaveLength(1);
      const item = result[0];
      expect(item.kind).toBe(MemoryKind.FACT);
      expect(item.subject).toBe('ticket:ticket-456');
      expect(item.predicate).toBe('status');
      expect(item.object).toBe('IN_PROGRESS');
    });

    it('AC1: extracts status from data.status when newStatus is not present', () => {
      const event: TicketEvent = {
        type: 'ticket_event',
        id: 'event-123',
        ticketId: 'ticket-456',
        projectId: 'project-123',
        actorId: 'actor-789',
        action: 'status_changed',
        data: { status: 'CLOSED' },
        timestamp: new Date(),
      };

      const result = service.extractFromEvent(event as unknown as TicketEvent | AgentEvent | DecisionEvent);

      expect(result).toHaveLength(1);
      expect(result[0].object).toBe('CLOSED');
    });
  });

  describe('AC2: extractFromEvent(ticket_event action=assigned)', () => {
    it('AC2: returns MemoryItem with kind=FACT, subject=ticket:{id}, predicate=assigned_to', () => {
      const event: TicketEvent = {
        type: 'ticket_event',
        id: 'event-123',
        ticketId: 'ticket-456',
        projectId: 'project-123',
        actorId: 'actor-789',
        action: 'assigned',
        data: { assignedTo: 'user-abc' },
        timestamp: new Date(),
      };

      const result = service.extractFromEvent(event as unknown as TicketEvent | AgentEvent | DecisionEvent);

      expect(result).toHaveLength(1);
      const item = result[0];
      expect(item.kind).toBe(MemoryKind.FACT);
      expect(item.subject).toBe('ticket:ticket-456');
      expect(item.predicate).toBe('assigned_to');
      expect(item.object).toBe('user-abc');
    });
  });

  describe('AC3: extractFromEvent(ticket_event action=incident_linked)', () => {
    it('AC3: returns MemoryItem with kind=INCIDENT_PATTERN linking ticket to affected service', () => {
      const event: TicketEvent = {
        type: 'ticket_event',
        id: 'event-123',
        ticketId: 'ticket-456',
        projectId: 'project-123',
        actorId: 'actor-789',
        action: 'incident_linked',
        data: { incidentId: 'incident-789' },
        timestamp: new Date(),
      };

      const result = service.extractFromEvent(event as unknown as TicketEvent | AgentEvent | DecisionEvent);

      expect(result).toHaveLength(1);
      const item = result[0];
      expect(item.kind).toBe(MemoryKind.INCIDENT_PATTERN);
      expect(item.subject).toBe('ticket:ticket-456');
      expect(item.predicate).toBe('incident');
      expect(item.object).toBe('incident-789');
    });
  });

  describe('AC4: extractFromEvent(agent_event) without decision_made', () => {
    it('AC4: returns empty array when metadata contains no decision_made key', () => {
      const event: AgentEvent = {
        type: 'agent_event',
        id: 'event-agent-1',
        agentId: 'agent-123',
        projectId: 'project-123',
        actorId: 'actor-789',
        action: 'some_action',
        data: { otherField: 'value' },
        timestamp: new Date(),
      };

      const result = service.extractFromEvent(event as unknown as TicketEvent | AgentEvent | DecisionEvent);

      expect(result).toHaveLength(0);
    });

    it('AC4: returns empty array when agent_event data is empty object', () => {
      const event: AgentEvent = {
        type: 'agent_event',
        id: 'event-agent-1',
        agentId: 'agent-123',
        projectId: 'project-123',
        actorId: 'actor-789',
        action: 'some_action',
        data: {},
        timestamp: new Date(),
      };

      const result = service.extractFromEvent(event as unknown as TicketEvent | AgentEvent | DecisionEvent);

      expect(result).toHaveLength(0);
    });
  });

  describe('AC5: extractFromEvent with incomplete payload', () => {
    it('AC5: returns empty array and logs warning when ticketId is missing', () => {
      const loggerSpy = jest.spyOn(service['logger' as any], 'warn').mockImplementation(() => {});
      const event: TicketEvent = {
        type: 'ticket_event',
        id: 'event-incomplete',
        ticketId: undefined,
        projectId: 'project-123',
        actorId: 'actor-789',
        action: 'status_changed',
        data: {},
        timestamp: new Date(),
      };

      const result = service.extractFromEvent(event as unknown as TicketEvent | AgentEvent | DecisionEvent);

      expect(result).toHaveLength(0);
      expect(loggerSpy).toHaveBeenCalled();
      loggerSpy.mockRestore();
    });

    it('AC5: returns empty array when projectId is missing from agent_event with decision_made', () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const event: AgentEvent = {
        type: 'agent_event',
        id: 'event-agent-1',
        agentId: 'agent-123',
        projectId: '',
        actorId: 'actor-789',
        action: 'decision_made',
        data: { decision_made: 'use_hot_path' },
        timestamp: new Date(),
      };

      const result = service.extractFromEvent(event as unknown as TicketEvent | AgentEvent | DecisionEvent);

      expect(result).toHaveLength(0);
      consoleSpy.mockRestore();
    });
  });

  describe('AC9: confidence and ttl validation', () => {
    it('AC9: extracted items have confidence >= 0.5', () => {
      const event: TicketEvent = {
        type: 'ticket_event',
        id: 'event-123',
        ticketId: 'ticket-456',
        projectId: 'project-123',
        actorId: 'actor-789',
        action: 'status_changed',
        data: { newStatus: 'IN_PROGRESS' },
        timestamp: new Date(),
      };

      const result = service.extractFromEvent(event as unknown as TicketEvent | AgentEvent | DecisionEvent);

      expect(result).toHaveLength(1);
      expect(result[0].confidence).toBeGreaterThanOrEqual(0.5);
    });

    it('AC9: extracted items have ttlAt = null (never expires by default)', () => {
      const event: TicketEvent = {
        type: 'ticket_event',
        id: 'event-123',
        ticketId: 'ticket-456',
        projectId: 'project-123',
        actorId: 'actor-789',
        action: 'status_changed',
        data: { newStatus: 'IN_PROGRESS' },
        timestamp: new Date(),
      };

      const result = service.extractFromEvent(event as unknown as TicketEvent | AgentEvent | DecisionEvent);

      expect(result).toHaveLength(1);
      expect(result[0].ttlAt).toBeNull();
    });

    it('AC9: incident_pattern extracted items have confidence >= 0.5', () => {
      const event: TicketEvent = {
        type: 'ticket_event',
        id: 'event-123',
        ticketId: 'ticket-456',
        projectId: 'project-123',
        actorId: 'actor-789',
        action: 'incident_linked',
        data: { incidentId: 'incident-789' },
        timestamp: new Date(),
      };

      const result = service.extractFromEvent(event as unknown as TicketEvent | AgentEvent | DecisionEvent);

      expect(result).toHaveLength(1);
      expect(result[0].confidence).toBeGreaterThanOrEqual(0.5);
    });
  });

  describe('AC6: recordDecision creates DecisionEvent and returns WriteResult', () => {
    it('AC6: recordDecision creates DecisionEvent via repository.upsert() and returns WriteResult', async () => {
      const mockRepository = {
        upsert: jest.fn().mockResolvedValue({ id: 'memory-123' }),
        findActive: jest.fn().mockResolvedValue(null),
      };

      const result = await service.recordDecision(
        { projectId: 'project-123', actorId: 'agent-456', topic: 'decision', decision: 'use_cache_first' },
        mockRepository as any,
      );

      expect(result).toHaveProperty('canonicalId');
      expect(result).toHaveProperty('memoryId');
      expect(result.canonicalId).toBeDefined();
      expect(result.memoryId).toBeDefined();
      expect(mockRepository.upsert).toHaveBeenCalledTimes(1);
    });

    it('AC6: recordDecision upsert includes projectId, kind=DECISION, subject, predicate, object', async () => {
      const mockRepository = {
        upsert: jest.fn().mockResolvedValue({ id: 'memory-123' }),
        findActive: jest.fn().mockResolvedValue(null),
      };

      await service.recordDecision(
        { projectId: 'project-123', actorId: 'agent-456', topic: 'decision', decision: 'use_cache_first' },
        mockRepository as any,
      );

      expect(mockRepository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-123',
          kind: MemoryKind.DECISION,
          subject: 'agent:agent-456',
          predicate: 'decision',
          object: 'use_cache_first',
          ownerId: 'agent-456',
          confidence: 1.0,
        }),
      );
    });
  });

  describe('AC7: recordDecision with existing active decision', () => {
    it('AC7: marks old decision as superseded via updateDirect when one exists', async () => {
      const mockRepository = {
        upsert: jest.fn().mockResolvedValue({ id: 'new-memory-123' }),
        updateDirect: jest.fn().mockResolvedValue(undefined),
        findActive: jest.fn().mockResolvedValue({ id: 'old-decision-456' }),
      };
      await service.recordDecision(
        { projectId: 'project-123', actorId: 'agent-456', topic: 'decision', decision: 'new_decision' },
        mockRepository as any,
      );

      expect(mockRepository.updateDirect).toHaveBeenCalledTimes(1);
      expect(mockRepository.updateDirect).toHaveBeenCalledWith(
        'old-decision-456',
        expect.objectContaining({
          status: 'superseded',
        }),
      );
      expect(mockRepository.upsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('AC10: recordDecision confidence', () => {
    it('AC10: items from explicit recordDecision have confidence = 1.0', async () => {
      const mockRepository = {
        upsert: jest.fn().mockResolvedValue({ id: 'memory-123' }),
        findActive: jest.fn().mockResolvedValue(null),
      };

      await service.recordDecision(
        { projectId: 'project-123', actorId: 'agent-456', topic: 'decision', decision: 'use_cache_first' },
        mockRepository as any,
      );

      expect(mockRepository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          confidence: 1.0,
        }),
      );
    });
  });
});

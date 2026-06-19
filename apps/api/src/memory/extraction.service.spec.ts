import { Test, TestingModule } from '@nestjs/testing';
import { ExtractionService } from './extraction.service';
import { PrismaMemoryItemRepository } from './prisma-memory-item.repository';
import { MemoryKind } from '../common/enums';
import { MemoryItem } from './memory-item-repository';

const makeMemoryItem = (overrides: Partial<MemoryItem> = {}): MemoryItem => ({
  id: 'mem-1',
  projectId: 'project-123',
  kind: MemoryKind.DECISION,
  subject: 'agent:actor-1',
  predicate: 'topic',
  object: 'choice',
  status: 'active',
  confidence: 1.0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const createMockRepository = () => ({
  findActive: jest.fn(),
  updateDirect: jest.fn(),
  upsert: jest.fn(),
});

describe('ExtractionService', () => {
  let service: ExtractionService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ExtractionService],
    }).compile();

    service = module.get<ExtractionService>(ExtractionService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('extractFromEvent', () => {
    describe('ticket_event: status_changed', () => {
      it('extracts a FACT memory item for status_changed action', () => {
        const event = {
          type: 'ticket_event' as const,
          id: 'evt-1',
          ticketId: 'ticket-1',
          projectId: 'project-123',
          actorId: 'actor-1',
          action: 'status_changed',
          data: { newStatus: 'IN_PROGRESS' },
          timestamp: new Date(),
        };

        const result = service.extractFromEvent(event);

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
          projectId: 'project-123',
          kind: MemoryKind.FACT,
          subject: 'ticket:ticket-1',
          predicate: 'status',
          object: 'IN_PROGRESS',
          sourceType: 'ticket_event',
          sourceId: 'evt-1',
          confidence: 0.9,
        });
      });

      it('falls back to status field when newStatus is absent', () => {
        const event = {
          type: 'ticket_event' as const,
          id: 'evt-2',
          ticketId: 'ticket-1',
          projectId: 'project-123',
          actorId: 'actor-1',
          action: 'status_changed',
          data: { status: 'CLOSED' },
          timestamp: new Date(),
        };

        const result = service.extractFromEvent(event);

        expect(result[0].object).toBe('CLOSED');
      });

      it('returns empty array when data is invalid JSON string', () => {
        const event = {
          type: 'ticket_event' as const,
          id: 'evt-3',
          ticketId: 'ticket-1',
          projectId: 'project-123',
          actorId: 'actor-1',
          action: 'status_changed',
          data: 'not-valid-json',
          timestamp: new Date(),
        };

        const result = service.extractFromEvent(event);

        expect(result).toHaveLength(0);
      });
    });

    describe('ticket_event: assigned', () => {
      it('extracts a FACT memory item for assigned action', () => {
        const event = {
          type: 'ticket_event' as const,
          id: 'evt-4',
          ticketId: 'ticket-1',
          projectId: 'project-123',
          actorId: 'actor-1',
          action: 'assigned',
          data: { assignedTo: 'user-42' },
          timestamp: new Date(),
        };

        const result = service.extractFromEvent(event);

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
          kind: MemoryKind.FACT,
          subject: 'ticket:ticket-1',
          predicate: 'assigned_to',
          object: 'user-42',
          confidence: 0.85,
        });
      });
    });

    describe('ticket_event: incident_linked', () => {
      it('extracts an INCIDENT_PATTERN memory item', () => {
        const event = {
          type: 'ticket_event' as const,
          id: 'evt-5',
          ticketId: 'ticket-1',
          projectId: 'project-123',
          actorId: 'actor-1',
          action: 'incident_linked',
          data: { incidentId: 'inc-99' },
          timestamp: new Date(),
        };

        const result = service.extractFromEvent(event);

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
          kind: MemoryKind.INCIDENT_PATTERN,
          predicate: 'incident',
          object: 'inc-99',
          confidence: 0.75,
        });
      });
    });

    describe('ticket_event: missing projectId or ticketId', () => {
      it('returns empty array when projectId is missing', () => {
        const event = {
          type: 'ticket_event' as const,
          id: 'evt-6',
          ticketId: 'ticket-1',
          projectId: '',
          actorId: 'actor-1',
          action: 'status_changed',
          data: { newStatus: 'CLOSED' },
          timestamp: new Date(),
        };

        const result = service.extractFromEvent(event);

        expect(result).toHaveLength(0);
      });

      it('returns empty array when ticketId is missing', () => {
        const event = {
          type: 'ticket_event' as const,
          id: 'evt-7',
          ticketId: undefined,
          projectId: 'project-123',
          actorId: 'actor-1',
          action: 'status_changed',
          data: { newStatus: 'CLOSED' },
          timestamp: new Date(),
        };

        const result = service.extractFromEvent(event);

        expect(result).toHaveLength(0);
      });

      it('returns empty array for unknown ticket_event actions', () => {
        const event = {
          type: 'ticket_event' as const,
          id: 'evt-8',
          ticketId: 'ticket-1',
          projectId: 'project-123',
          actorId: 'actor-1',
          action: 'unknown_action',
          data: {},
          timestamp: new Date(),
        };

        const result = service.extractFromEvent(event);

        expect(result).toHaveLength(0);
      });
    });

    describe('agent_event: decision_made', () => {
      it('extracts a DECISION memory item for decision_made action', () => {
        const event = {
          type: 'agent_event' as const,
          id: 'evt-9',
          agentId: 'agent-1',
          projectId: 'project-123',
          actorId: 'actor-1',
          action: 'decision_made',
          data: { decision: 'use microservices', rationale: 'scalability' },
          timestamp: new Date(),
        };

        const result = service.extractFromEvent(event);

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
          kind: MemoryKind.DECISION,
          subject: 'agent:agent-1',
          predicate: 'decision',
          object: 'use microservices',
          confidence: 0.95,
        });
      });

      it('returns empty array for unknown agent_event actions', () => {
        const event = {
          type: 'agent_event' as const,
          id: 'evt-10',
          agentId: 'agent-1',
          projectId: 'project-123',
          actorId: 'actor-1',
          action: 'other_action',
          data: {},
          timestamp: new Date(),
        };

        const result = service.extractFromEvent(event);

        expect(result).toHaveLength(0);
      });

      it('returns empty array when projectId is missing', () => {
        const event = {
          type: 'agent_event' as const,
          id: 'evt-11',
          agentId: 'agent-1',
          projectId: '',
          actorId: 'actor-1',
          action: 'decision_made',
          data: { decision: 'something' },
          timestamp: new Date(),
        };

        const result = service.extractFromEvent(event);

        expect(result).toHaveLength(0);
      });
    });

    describe('decision_event', () => {
      it('extracts a DECISION memory item from decision_event with confidence 1.0', () => {
        const event = {
          type: 'decision_event' as const,
          id: 'evt-12',
          agentId: 'agent-1',
          projectId: 'project-123',
          actorId: 'actor-1',
          action: 'decided',
          decision: 'use REST',
          data: {},
          timestamp: new Date(),
        };

        const result = service.extractFromEvent(event);

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
          kind: MemoryKind.DECISION,
          subject: 'agent:agent-1',
          predicate: 'decision',
          object: 'use REST',
          sourceType: 'decision_event',
          sourceId: 'evt-12',
          confidence: 1.0,
        });
      });

      it('returns empty array when projectId is missing', () => {
        const event = {
          type: 'decision_event' as const,
          id: 'evt-13',
          agentId: 'agent-1',
          projectId: '',
          actorId: 'actor-1',
          action: 'decided',
          decision: 'something',
          data: {},
          timestamp: new Date(),
        };

        const result = service.extractFromEvent(event);

        expect(result).toHaveLength(0);
      });
    });

    describe('unknown event type', () => {
      it('returns empty array for an unrecognized event type', () => {
        const event = {
          type: 'unknown_type',
          id: 'evt-99',
          projectId: 'project-123',
          actorId: 'actor-1',
          action: 'something',
          data: {},
          timestamp: new Date(),
        };

        const result = service.extractFromEvent(event as Parameters<typeof service.extractFromEvent>[0]);

        expect(result).toHaveLength(0);
      });
    });
  });

  describe('recordDecision', () => {
    it('creates a new decision and returns canonicalId and memoryId', async () => {
      const mockRepository = createMockRepository();
      const createdItem = makeMemoryItem({ id: 'mem-new' });
      mockRepository.findActive.mockResolvedValue(null);
      mockRepository.upsert.mockResolvedValue(createdItem);

      const result = await service.recordDecision(
        {
          projectId: 'project-123',
          actorId: 'actor-1',
          topic: 'architecture',
          decision: 'use microservices',
          rationale: 'scalability needs',
          sourceId: 'src-1',
        },
        mockRepository as unknown as PrismaMemoryItemRepository,
      );

      expect(result).toEqual({ canonicalId: 'src-1', memoryId: 'mem-new' });
      expect(mockRepository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: MemoryKind.DECISION,
          subject: 'agent:actor-1',
          predicate: 'architecture',
          object: 'use microservices',
          confidence: 1.0,
        }),
      );
    });

    it('supersedes the existing active decision before creating a new one', async () => {
      const mockRepository = createMockRepository();
      const existing = makeMemoryItem({ id: 'mem-old', status: 'active' });
      const created = makeMemoryItem({ id: 'mem-new' });
      mockRepository.findActive.mockResolvedValue(existing);
      mockRepository.upsert.mockResolvedValue(created);

      await service.recordDecision(
        {
          projectId: 'project-123',
          actorId: 'actor-1',
          topic: 'architecture',
          decision: 'use monolith',
        },
        mockRepository as unknown as PrismaMemoryItemRepository,
      );

      expect(mockRepository.updateDirect).toHaveBeenCalledWith('mem-old', {
        status: 'superseded',
        activeKey: null,
        supersededBy: undefined,
      });
      expect(mockRepository.upsert).toHaveBeenCalled();
    });

    it('uses memory id as canonicalId when sourceId is not provided', async () => {
      const mockRepository = createMockRepository();
      const created = makeMemoryItem({ id: 'mem-fallback' });
      mockRepository.findActive.mockResolvedValue(null);
      mockRepository.upsert.mockResolvedValue(created);

      const result = await service.recordDecision(
        {
          projectId: 'project-123',
          actorId: 'actor-1',
          topic: 'design',
          decision: 'REST',
        },
        mockRepository as unknown as PrismaMemoryItemRepository,
      );

      expect(result.canonicalId).toBe('mem-fallback');
      expect(result.memoryId).toBe('mem-fallback');
    });
  });
});

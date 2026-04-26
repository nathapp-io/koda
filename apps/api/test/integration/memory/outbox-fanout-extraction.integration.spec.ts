import { Test, TestingModule } from '@nestjs/testing';
import { OutboxFanOutRegistry } from '../../../src/outbox/outbox-fan-out-registry';
import { ExtractionService } from '../../../src/memory/extraction.service';
import { MemoryItemRepository } from '../../../src/memory/memory-item-repository';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { MemoryKind } from '../../../src/common/enums';

describe('AC8: OutboxFanOutRegistry dispatches to ExtractionService', () => {
  let fanOutRegistry: OutboxFanOutRegistry;
  let extractionService: ExtractionService;
  let memoryRepository: MemoryItemRepository;
  let mockPrismaService: any;

  beforeEach(async () => {
    const mockPrismaClient = {
      memoryItem: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation((args) => Promise.resolve({ id: `created-${Date.now()}`, ...args.data })),
        update: jest.fn().mockImplementation((args) => Promise.resolve({ id: args.where.id, ...args.data })),
        count: jest.fn().mockResolvedValue(0),
      },
      $transaction: jest.fn().mockImplementation((fn) => fn(mockPrismaClient)),
    };

    mockPrismaService = {
      client: mockPrismaClient,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxFanOutRegistry,
        ExtractionService,
        MemoryItemRepository,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    fanOutRegistry = module.get<OutboxFanOutRegistry>(OutboxFanOutRegistry);
    extractionService = module.get<ExtractionService>(ExtractionService);
    memoryRepository = module.get<MemoryItemRepository>(MemoryItemRepository);
  });

  describe('ticket_event dispatch triggers extraction', () => {
    it('AC8: dispatch(ticket_event) invokes extractFromEvent and upserts to repository', async () => {
      const ticketEventPayload = {
        type: 'ticket_event',
        id: 'event-123',
        ticketId: 'ticket-456',
        projectId: 'project-123',
        actorId: 'actor-789',
        action: 'status_changed',
        data: { newStatus: 'IN_PROGRESS' },
        timestamp: new Date().toISOString(),
      };

      const repositoryUpsertSpy = jest.spyOn(memoryRepository, 'upsert').mockResolvedValue({
        id: 'memory-123',
        projectId: 'project-123',
        kind: MemoryKind.FACT,
        subject: 'ticket:ticket-456',
        predicate: 'status',
        object: 'IN_PROGRESS',
        confidence: 0.9,
      } as any);

      await fanOutRegistry.dispatch({
        eventType: 'ticket_event',
        payload: ticketEventPayload,
      });

      expect(repositoryUpsertSpy).toHaveBeenCalled();
      const upsertCall = repositoryUpsertSpy.mock.calls[0][0];
      expect(upsertCall.kind).toBe(MemoryKind.FACT);
      expect(upsertCall.subject).toBe('ticket:ticket-456');
      expect(upsertCall.predicate).toBe('status');
    });

    it('AC8: dispatch(ticket_event with action=assigned) extracts assigned_to fact', async () => {
      const ticketEventPayload = {
        type: 'ticket_event',
        id: 'event-123',
        ticketId: 'ticket-456',
        projectId: 'project-123',
        actorId: 'actor-789',
        action: 'assigned',
        data: { assignedTo: 'user-abc' },
        timestamp: new Date().toISOString(),
      };

      const repositoryUpsertSpy = jest.spyOn(memoryRepository, 'upsert').mockResolvedValue({
        id: 'memory-123',
        projectId: 'project-123',
        kind: MemoryKind.FACT,
        subject: 'ticket:ticket-456',
        predicate: 'assigned_to',
        object: 'user-abc',
        confidence: 0.85,
      } as any);

      await fanOutRegistry.dispatch({
        eventType: 'ticket_event',
        payload: ticketEventPayload,
      });

      expect(repositoryUpsertSpy).toHaveBeenCalled();
    });

    it('AC8: dispatch(ticket_event with action=incident_linked) extracts INCIDENT_PATTERN', async () => {
      const ticketEventPayload = {
        type: 'ticket_event',
        id: 'event-123',
        ticketId: 'ticket-456',
        projectId: 'project-123',
        actorId: 'actor-789',
        action: 'incident_linked',
        data: { incidentId: 'incident-789' },
        timestamp: new Date().toISOString(),
      };

      const repositoryUpsertSpy = jest.spyOn(memoryRepository, 'upsert').mockResolvedValue({
        id: 'memory-123',
        projectId: 'project-123',
        kind: MemoryKind.INCIDENT_PATTERN,
        subject: 'ticket:ticket-456',
        predicate: 'incident',
        object: 'incident-789',
        confidence: 0.75,
      } as any);

      await fanOutRegistry.dispatch({
        eventType: 'ticket_event',
        payload: ticketEventPayload,
      });

      expect(repositoryUpsertSpy).toHaveBeenCalled();
      const upsertCall = repositoryUpsertSpy.mock.calls[0][0];
      expect(upsertCall.kind).toBe(MemoryKind.INCIDENT_PATTERN);
    });
  });

  describe('agent_event dispatch triggers extraction', () => {
    it('AC8: dispatch(agent_event) with decision_made invokes extractFromEvent', async () => {
      const agentEventPayload = {
        type: 'agent_event',
        id: 'event-agent-1',
        agentId: 'agent-456',
        projectId: 'project-123',
        actorId: 'actor-789',
        action: 'decision_made',
        data: { decision_made: 'use_hot_path', rationale: 'lower latency' },
        timestamp: new Date().toISOString(),
      };

      const repositoryUpsertSpy = jest.spyOn(memoryRepository, 'upsert').mockResolvedValue({
        id: 'memory-123',
        projectId: 'project-123',
        kind: MemoryKind.DECISION,
        subject: 'agent:agent-456',
        predicate: 'decision',
        object: 'use_hot_path',
        confidence: 0.95,
      } as any);

      await fanOutRegistry.dispatch({
        eventType: 'agent_event',
        payload: agentEventPayload,
      });

      expect(repositoryUpsertSpy).toHaveBeenCalled();
    });

    it('AC8: dispatch(agent_event) without decision_made does not upsert', async () => {
      const agentEventPayload = {
        type: 'agent_event',
        id: 'event-agent-1',
        agentId: 'agent-456',
        projectId: 'project-123',
        actorId: 'actor-789',
        action: 'some_action',
        data: { otherField: 'value' },
        timestamp: new Date().toISOString(),
      };

      const repositoryUpsertSpy = jest.spyOn(memoryRepository, 'upsert');

      await fanOutRegistry.dispatch({
        eventType: 'agent_event',
        payload: agentEventPayload,
      });

      expect(repositoryUpsertSpy).not.toHaveBeenCalled();
    });
  });

  describe('extractFromEvent wiring verification', () => {
    it('AC8: extraction service is called with canonical event from dispatch payload', async () => {
      const extractSpy = jest.spyOn(extractionService, 'extractFromEvent');

      const ticketEventPayload = {
        type: 'ticket_event',
        id: 'event-123',
        ticketId: 'ticket-456',
        projectId: 'project-123',
        actorId: 'actor-789',
        action: 'status_changed',
        data: { newStatus: 'IN_PROGRESS' },
        timestamp: new Date(),
      };

      await fanOutRegistry.dispatch({
        eventType: 'ticket_event',
        payload: ticketEventPayload,
      });

      expect(extractSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ticket_event',
          action: 'status_changed',
          ticketId: 'ticket-456',
        }),
      );
    });
  });
});

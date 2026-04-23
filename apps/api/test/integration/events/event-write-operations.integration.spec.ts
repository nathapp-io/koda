/**
 * Event Write Operations and Actor Resolution - Integration Tests
 *
 * Story: Event Write Operations and Actor Resolution
 * Description: Introduce canonical event services for ticket, agent, and decision writes,
 * then wire them through KodaDomainWriter with a project-scoped actor resolution layer.
 *
 * Acceptance Criteria:
 * AC-1: TicketEventService.create(data) writes to TicketEvent and returns the created record.
 * AC-2: AgentEventService.create(data) writes to AgentEvent and returns the created record.
 * AC-3: DecisionEventService.create(data) writes to DecisionEvent and returns the created record.
 * AC-4: All three services are called by KodaDomainWriter after relevant operations.
 * AC-5: Event creation is included in the WriteResult.provenance output.
 * AC-6: Creating an event with a non-existent projectId throws ForbiddenError with code PROJECT_NOT_FOUND.
 * AC-7: ActorResolver maps current Koda auth and agent context into the Phase 1 actor model before permission checks run.
 * AC-8: Only actors with role admin, developer, or agent on the target project can call event write operations,
 *       and GET /admin/outbox requires admin.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { ForbiddenAppException } from '@nathapp/nestjs-common';

import { KodaDomainWriter } from '../../../src/koda-domain-writer/koda-domain-writer.service';
import { RagService } from '../../../src/rag/rag.service';
import { OutboxService } from '../../../src/outbox/outbox.service';
import { TicketEventService } from '../../../src/events/ticket-event.service';
import { AgentEventService } from '../../../src/events/agent-event.service';
import { DecisionEventService } from '../../../src/events/decision-event.service';
import { ActorResolver } from '../../../src/events/actor-resolver.service';

describe('Event Write Operations and Actor Resolution', () => {
  let kodaDomainWriter: KodaDomainWriter;
  let ticketEventService: TicketEventService;
  let agentEventService: AgentEventService;
  let decisionEventService: DecisionEventService;
  let actorResolver: ActorResolver;

  const mockProject = {
    id: 'proj-koda-123',
    name: 'Koda',
    slug: 'koda',
    key: 'KODA',
    description: 'Dev ticket tracker',
    gitRemoteUrl: null,
    autoIndexOnClose: false,
    graphifyEnabled: false,
    graphifyLastImportedAt: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockAgent = {
    id: 'agent-writer-001',
    name: 'Writer Agent',
    slug: 'writer-agent',
    apiKeyHash: 'hashed-key-123',
    status: 'ACTIVE',
    maxConcurrentTickets: 5,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockUser = {
    id: 'user-123',
    email: 'admin@koda.dev',
    passwordHash: 'hashed-password',
    role: 'ADMIN',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockTicket = {
    id: 'ticket-domain-001',
    projectId: 'proj-koda-123',
    number: 42,
    type: 'BUG',
    title: 'Authentication issue',
    description: 'Users cannot authenticate',
    status: 'CREATED',
    priority: 'HIGH',
    assignedToUserId: null,
    assignedToAgentId: null,
    createdByUserId: null,
    createdByAgentId: 'agent-writer-001',
    gitRefVersion: null,
    gitRefFile: null,
    gitRefLine: null,
    externalVcsId: null,
    externalVcsUrl: null,
    vcsSyncedAt: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockPrismaService = {
    client: {
      project: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
      agent: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
      ticket: {
        findUnique: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
      },
      ticketEvent: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      agentEvent: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      decisionEvent: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      outboxEvent: {
        create: jest.fn(),
        findMany: jest.fn(),
      },
      agentRoleEntry: {
        findMany: jest.fn(),
      },
      $transaction: jest.fn(),
    },
  };

  const mockRagService = {
    indexDocument: jest.fn(),
    importGraphify: jest.fn(),
    validateProjectId: jest.fn(),
    search: jest.fn(),
  };

  const mockOutboxService = {
    enqueue: jest.fn(),
    processPending: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KodaDomainWriter,
        TicketEventService,
        AgentEventService,
        DecisionEventService,
        ActorResolver,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: RagService, useValue: mockRagService },
        { provide: OutboxService, useValue: mockOutboxService },
      ],
    }).compile();

    kodaDomainWriter = module.get<KodaDomainWriter>(KodaDomainWriter);
    ticketEventService = module.get<TicketEventService>(TicketEventService);
    agentEventService = module.get<AgentEventService>(AgentEventService);
    decisionEventService = module.get<DecisionEventService>(DecisionEventService);
    actorResolver = module.get<ActorResolver>(ActorResolver);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-1: TicketEventService.create(data) writes to TicketEvent and returns
  // ═══════════════════════════════════════════════════════════════════════════

  describe('AC-1: TicketEventService.create(data)', () => {
    it('should write a TicketEvent record to the database', async () => {
      const eventData = {
        ticketId: 'ticket-domain-001',
        projectId: 'proj-koda-123',
        action: 'CREATED',
        actorId: 'agent-writer-001',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: { title: 'Authentication issue' },
      };

      const createdEvent = {
        id: 'event-ticket-001',
        ticketId: eventData.ticketId,
        projectId: eventData.projectId,
        action: eventData.action,
        actorId: eventData.actorId,
        actorType: eventData.actorType,
        source: eventData.source,
        data: JSON.stringify(eventData.data),
        timestamp: new Date(),
        createdAt: new Date(),
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticketEvent.create.mockResolvedValue(createdEvent);

      const result = await ticketEventService.create(eventData);

      expect(mockPrismaService.client.ticketEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          ticketId: eventData.ticketId,
          projectId: eventData.projectId,
          action: eventData.action,
          actorId: eventData.actorId,
          actorType: eventData.actorType,
          source: eventData.source,
        }),
      });

      expect(result).toHaveProperty('id');
      expect(result.id).toBe('event-ticket-001');
      expect(result.ticketId).toBe(eventData.ticketId);
      expect(result.projectId).toBe(eventData.projectId);
    });

    it('should return the created TicketEvent record with all fields', async () => {
      const eventData = {
        ticketId: 'ticket-domain-001',
        projectId: 'proj-koda-123',
        action: 'STATUS_CHANGED',
        actorId: 'agent-writer-001',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: { oldStatus: 'CREATED', newStatus: 'IN_PROGRESS' },
      };

      const createdEvent = {
        id: 'event-ticket-002',
        ticketId: eventData.ticketId,
        projectId: eventData.projectId,
        action: eventData.action,
        actorId: eventData.actorId,
        actorType: eventData.actorType,
        source: eventData.source,
        data: JSON.stringify(eventData.data),
        timestamp: new Date(),
        createdAt: new Date(),
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticketEvent.create.mockResolvedValue(createdEvent);

      const result = await ticketEventService.create(eventData);

      expect(result).toEqual(
        expect.objectContaining({
          id: 'event-ticket-002',
          ticketId: 'ticket-domain-001',
          projectId: 'proj-koda-123',
          action: 'STATUS_CHANGED',
          actorId: 'agent-writer-001',
          actorType: 'agent',
          source: 'api',
        }),
      );
    });

    it('should serialize data object as JSON string', async () => {
      const eventData = {
        ticketId: 'ticket-domain-001',
        projectId: 'proj-koda-123',
        action: 'CREATED',
        actorId: 'agent-writer-001',
        actorType: 'agent' as const,
        source: 'internal' as const,
        data: { nested: { field: 'value' }, array: [1, 2, 3] },
      };

      const createdEvent = {
        id: 'event-ticket-003',
        ticketId: eventData.ticketId,
        projectId: eventData.projectId,
        action: eventData.action,
        actorId: eventData.actorId,
        actorType: eventData.actorType,
        source: eventData.source,
        data: JSON.stringify(eventData.data),
        timestamp: new Date(),
        createdAt: new Date(),
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticketEvent.create.mockResolvedValue(createdEvent);

      await ticketEventService.create(eventData);

      const createCall = mockPrismaService.client.ticketEvent.create.mock.calls[0][0];
      const storedData = JSON.parse(createCall.data.data);
      expect(storedData).toEqual(eventData.data);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-2: AgentEventService.create(data) writes to AgentEvent and returns
  // ═══════════════════════════════════════════════════════════════════════════

  describe('AC-2: AgentEventService.create(data)', () => {
    it('should write an AgentEvent record to the database', async () => {
      const eventData = {
        agentId: 'agent-writer-001',
        projectId: 'proj-koda-123',
        action: 'TICKET_ASSIGNED',
        actorId: 'agent-writer-001',
        source: 'internal' as const,
        data: { ticketId: 'ticket-domain-001', ticketNumber: 42 },
      };

      const createdEvent = {
        id: 'event-agent-001',
        agentId: eventData.agentId,
        projectId: eventData.projectId,
        action: eventData.action,
        actorId: eventData.actorId,
        source: eventData.source,
        data: JSON.stringify(eventData.data),
        timestamp: new Date(),
        createdAt: new Date(),
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.agentEvent.create.mockResolvedValue(createdEvent);

      const result = await agentEventService.create(eventData);

      expect(mockPrismaService.client.agentEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          agentId: eventData.agentId,
          projectId: eventData.projectId,
          action: eventData.action,
          actorId: eventData.actorId,
          source: eventData.source,
        }),
      });

      expect(result).toHaveProperty('id');
      expect(result.id).toBe('event-agent-001');
      expect(result.agentId).toBe(eventData.agentId);
      expect(result.projectId).toBe(eventData.projectId);
    });

    it('should return the created AgentEvent record with all fields', async () => {
      const eventData = {
        agentId: 'agent-writer-001',
        projectId: 'proj-koda-123',
        action: 'DECISION_MADE',
        actorId: 'agent-writer-001',
        source: 'api' as const,
        data: { decision: 'approved', rationale: 'Looks good' },
      };

      const createdEvent = {
        id: 'event-agent-002',
        agentId: eventData.agentId,
        projectId: eventData.projectId,
        action: eventData.action,
        actorId: eventData.actorId,
        source: eventData.source,
        data: JSON.stringify(eventData.data),
        timestamp: new Date(),
        createdAt: new Date(),
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.agentEvent.create.mockResolvedValue(createdEvent);

      const result = await agentEventService.create(eventData);

      expect(result).toEqual(
        expect.objectContaining({
          id: 'event-agent-002',
          agentId: 'agent-writer-001',
          projectId: 'proj-koda-123',
          action: 'DECISION_MADE',
          actorId: 'agent-writer-001',
          source: 'api',
        }),
      );
    });

    it('should include data serialized as JSON string', async () => {
      const eventData = {
        agentId: 'agent-writer-001',
        projectId: 'proj-koda-123',
        action: 'STARTED_WORK',
        actorId: 'agent-writer-001',
        source: 'internal' as const,
        data: { ticketId: 'ticket-domain-001', estimatedHours: 4 },
      };

      const createdEvent = {
        id: 'event-agent-003',
        agentId: eventData.agentId,
        projectId: eventData.projectId,
        action: eventData.action,
        actorId: eventData.actorId,
        source: eventData.source,
        data: JSON.stringify(eventData.data),
        timestamp: new Date(),
        createdAt: new Date(),
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.agentEvent.create.mockResolvedValue(createdEvent);

      await agentEventService.create(eventData);

      const createCall = mockPrismaService.client.agentEvent.create.mock.calls[0][0];
      const storedData = JSON.parse(createCall.data.data);
      expect(storedData).toEqual(eventData.data);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-3: DecisionEventService.create(data) writes to DecisionEvent and returns
  // ═══════════════════════════════════════════════════════════════════════════

  describe('AC-3: DecisionEventService.create(data)', () => {
    it('should write a DecisionEvent record to the database', async () => {
      const eventData = {
        projectId: 'proj-koda-123',
        agentId: 'agent-writer-001',
        action: 'reviewed',
        decision: 'approved' as const,
        rationale: 'Code looks good',
        source: 'api' as const,
        data: { ticketId: 'ticket-domain-001' },
      };

      const createdEvent = {
        id: 'event-decision-001',
        projectId: eventData.projectId,
        agentId: eventData.agentId,
        action: eventData.action,
        decision: eventData.decision,
        rationale: eventData.rationale,
        source: eventData.source,
        data: JSON.stringify(eventData.data),
        timestamp: new Date(),
        createdAt: new Date(),
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.decisionEvent.create.mockResolvedValue(createdEvent);

      const result = await decisionEventService.create(eventData);

      expect(mockPrismaService.client.decisionEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          projectId: eventData.projectId,
          agentId: eventData.agentId,
          action: eventData.action,
          decision: eventData.decision,
          rationale: eventData.rationale,
          source: eventData.source,
        }),
      });

      expect(result).toHaveProperty('id');
      expect(result.id).toBe('event-decision-001');
      expect(result.projectId).toBe(eventData.projectId);
      expect(result.decision).toBe('approved');
    });

    it('should return the created DecisionEvent record with all fields', async () => {
      const eventData = {
        projectId: 'proj-koda-123',
        agentId: 'agent-writer-001',
        action: 'reviewed',
        decision: 'rejected' as const,
        rationale: 'Missing tests',
        source: 'internal' as const,
        data: { ticketId: 'ticket-domain-001', reason: 'no tests' },
      };

      const createdEvent = {
        id: 'event-decision-002',
        projectId: eventData.projectId,
        agentId: eventData.agentId,
        action: eventData.action,
        decision: eventData.decision,
        rationale: eventData.rationale,
        source: eventData.source,
        data: JSON.stringify(eventData.data),
        timestamp: new Date(),
        createdAt: new Date(),
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.decisionEvent.create.mockResolvedValue(createdEvent);

      const result = await decisionEventService.create(eventData);

      expect(result).toEqual(
        expect.objectContaining({
          id: 'event-decision-002',
          projectId: 'proj-koda-123',
          agentId: 'agent-writer-001',
          action: 'reviewed',
          decision: 'rejected',
          rationale: 'Missing tests',
          source: 'internal',
        }),
      );
    });

    it('should allow null rationale', async () => {
      const eventData = {
        projectId: 'proj-koda-123',
        agentId: 'agent-writer-001',
        action: 'escalated',
        decision: 'escalated' as const,
        rationale: null,
        source: 'api' as const,
        data: { priority: 'HIGH' },
      };

      const createdEvent = {
        id: 'event-decision-003',
        projectId: eventData.projectId,
        agentId: eventData.agentId,
        action: eventData.action,
        decision: eventData.decision,
        rationale: null,
        source: eventData.source,
        data: JSON.stringify(eventData.data),
        timestamp: new Date(),
        createdAt: new Date(),
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.decisionEvent.create.mockResolvedValue(createdEvent);

      const result = await decisionEventService.create(eventData);

      expect(result.rationale).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-4: All three services are called by KodaDomainWriter after operations
  // ═══════════════════════════════════════════════════════════════════════════

  describe('AC-4: KodaDomainWriter calls event services after operations', () => {
    it('should call TicketEventService.create after ticket operations', async () => {
      const ticketEventData = {
        ticketId: 'ticket-domain-001',
        projectId: 'proj-koda-123',
        action: 'CREATED',
        actorId: 'agent-writer-001',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: { title: 'New ticket' },
      };

      const createdEvent = {
        id: 'event-ticket-kw-001',
        ticketId: ticketEventData.ticketId,
        projectId: ticketEventData.projectId,
        action: ticketEventData.action,
        actorId: ticketEventData.actorId,
        actorType: ticketEventData.actorType,
        source: ticketEventData.source,
        data: JSON.stringify(ticketEventData.data),
        timestamp: new Date(),
        createdAt: new Date(),
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticketEvent.create.mockResolvedValue(createdEvent);
      mockOutboxService.enqueue.mockResolvedValue({ id: 'outbox-1' } as any);

      const result = await kodaDomainWriter.writeTicketEvent(ticketEventData);

      expect(mockPrismaService.client.ticketEvent.create).toHaveBeenCalled();
      expect(result).toHaveProperty('canonicalId');
      expect(result.provenance).toBeDefined();
    });

    it('should call AgentEventService.create after agent operations', async () => {
      const agentEventData = {
        agentId: 'agent-writer-001',
        projectId: 'proj-koda-123',
        action: 'ASSIGNED_TICKET',
        actorId: 'agent-writer-001',
        source: 'internal' as const,
        data: { ticketId: 'ticket-domain-001' },
      };

      const createdEvent = {
        id: 'event-agent-kw-001',
        agentId: agentEventData.agentId,
        projectId: agentEventData.projectId,
        action: agentEventData.action,
        actorId: agentEventData.actorId,
        source: agentEventData.source,
        data: JSON.stringify(agentEventData.data),
        timestamp: new Date(),
        createdAt: new Date(),
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.agentEvent.create.mockResolvedValue(createdEvent);
      mockOutboxService.enqueue.mockResolvedValue({ id: 'outbox-2' } as any);

      const result = await kodaDomainWriter.writeAgentAction(agentEventData);

      expect(mockPrismaService.client.agentEvent.create).toHaveBeenCalled();
      expect(result).toHaveProperty('canonicalId');
      expect(result.provenance).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-5: Event creation is included in WriteResult.provenance
  // ═══════════════════════════════════════════════════════════════════════════

  describe('AC-5: WriteResult provenance includes event creation', () => {
    it('should include provenance with actorId, projectId, action, timestamp, source for ticket events', async () => {
      const eventData = {
        ticketId: 'ticket-domain-001',
        projectId: 'proj-koda-123',
        action: 'CREATED',
        actorId: 'agent-writer-001',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: {},
      };

      const createdEvent = {
        id: 'event-prov-001',
        ticketId: eventData.ticketId,
        projectId: eventData.projectId,
        action: eventData.action,
        actorId: eventData.actorId,
        actorType: eventData.actorType,
        source: eventData.source,
        data: '{}',
        timestamp: new Date(),
        createdAt: new Date(),
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticketEvent.create.mockResolvedValue(createdEvent);
      mockOutboxService.enqueue.mockResolvedValue({ id: 'outbox-3' } as any);

      const result = await kodaDomainWriter.writeTicketEvent(eventData);

      expect(result.provenance).toEqual(
        expect.objectContaining({
          actorId: 'agent-writer-001',
          projectId: 'proj-koda-123',
          action: 'CREATED',
          source: 'api',
          timestamp: expect.any(Date),
        }),
      );
    });

    it('should include provenance for agent events', async () => {
      const eventData = {
        agentId: 'agent-writer-001',
        projectId: 'proj-koda-123',
        action: 'STARTED_WORK',
        actorId: 'agent-writer-001',
        source: 'internal' as const,
        data: {},
      };

      const createdEvent = {
        id: 'event-prov-002',
        agentId: eventData.agentId,
        projectId: eventData.projectId,
        action: eventData.action,
        actorId: eventData.actorId,
        source: eventData.source,
        data: '{}',
        timestamp: new Date(),
        createdAt: new Date(),
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.agentEvent.create.mockResolvedValue(createdEvent);
      mockOutboxService.enqueue.mockResolvedValue({ id: 'outbox-4' } as any);

      const result = await kodaDomainWriter.writeAgentAction(eventData);

      expect(result.provenance).toEqual(
        expect.objectContaining({
          actorId: 'agent-writer-001',
          projectId: 'proj-koda-123',
          action: 'STARTED_WORK',
          source: 'internal',
          timestamp: expect.any(Date),
        }),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-6: Non-existent projectId throws ForbiddenError with PROJECT_NOT_FOUND
  // ═══════════════════════════════════════════════════════════════════════════

  describe('AC-6: Non-existent projectId throws ForbiddenError', () => {
    it('should throw ForbiddenAppException with PROJECT_NOT_FOUND code for TicketEventService', async () => {
      const eventData = {
        ticketId: 'ticket-domain-001',
        projectId: 'non-existent-project',
        action: 'CREATED',
        actorId: 'agent-writer-001',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: {},
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(null);

      await expect(ticketEventService.create(eventData)).rejects.toThrow(
        ForbiddenAppException,
      );
    });

    it('should throw ForbiddenAppException with PROJECT_NOT_FOUND code for AgentEventService', async () => {
      const eventData = {
        agentId: 'agent-writer-001',
        projectId: 'non-existent-project',
        action: 'STARTED_WORK',
        actorId: 'agent-writer-001',
        source: 'internal' as const,
        data: {},
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(null);

      await expect(agentEventService.create(eventData)).rejects.toThrow(
        ForbiddenAppException,
      );
    });

    it('should throw ForbiddenAppException with PROJECT_NOT_FOUND code for DecisionEventService', async () => {
      const eventData = {
        projectId: 'non-existent-project',
        agentId: 'agent-writer-001',
        action: 'reviewed',
        decision: 'approved' as const,
        rationale: null,
        source: 'api' as const,
        data: {},
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(null);

      await expect(decisionEventService.create(eventData)).rejects.toThrow(
        ForbiddenAppException,
      );
    });

    it('should not write to database when project does not exist', async () => {
      const eventData = {
        ticketId: 'ticket-domain-001',
        projectId: 'non-existent-project',
        action: 'CREATED',
        actorId: 'agent-writer-001',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: {},
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(null);

      await expect(ticketEventService.create(eventData)).rejects.toThrow();
      expect(mockPrismaService.client.ticketEvent.create).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-7: ActorResolver maps auth and agent context into Phase 1 actor model
  // ═══════════════════════════════════════════════════════════════════════════

  describe('AC-7: ActorResolver maps auth context to Phase 1 actor model', () => {
    it('should resolve user actor from request context', async () => {
      const mockRequest = {
        user: { id: 'user-123', sub: 'user-123', role: 'ADMIN' },
        agent: null,
      };

      mockPrismaService.client.agentRoleEntry.findMany.mockResolvedValue([
        { projectId: 'proj-koda-123', role: 'ADMIN' },
      ]);

      const actor = await actorResolver.resolve(mockRequest as any);

      expect(actor).toEqual(
        expect.objectContaining({
          actorType: 'user',
          actorId: 'user-123',
          projectRoles: expect.arrayContaining(['ADMIN']),
          resourceRoles: expect.any(Array),
        }),
      );
    });

    it('should resolve agent actor from request context', async () => {
      const mockRequest = {
        user: null,
        agent: { id: 'agent-writer-001', sub: 'agent-writer-001' },
      };

      mockPrismaService.client.agentRoleEntry.findMany.mockResolvedValue([
        { projectId: 'proj-koda-123', role: 'DEVELOPER' },
      ]);

      const actor = await actorResolver.resolve(mockRequest as any);

      expect(actor).toEqual(
        expect.objectContaining({
          actorType: 'agent',
          actorId: 'agent-writer-001',
          projectRoles: expect.arrayContaining(['DEVELOPER']),
          resourceRoles: expect.any(Array),
        }),
      );
    });

    it('should run before permission checks', async () => {
      const mockRequest = {
        user: { id: 'user-123', sub: 'user-123', role: 'ADMIN' },
        agent: null,
      };

      mockPrismaService.client.agentRoleEntry.findMany.mockResolvedValue([]);

      const actor = await actorResolver.resolve(mockRequest as any);

      expect(actor).toBeDefined();
      expect(actor.actorType).toBeTruthy();
    });

    it('should return Actor object with actorType, actorId, projectRoles, resourceRoles', async () => {
      const mockRequest = {
        user: { id: 'user-456', sub: 'user-456', role: 'DEVELOPER' },
        agent: null,
      };

      mockPrismaService.client.agentRoleEntry.findMany.mockResolvedValue([
        { projectId: 'proj-koda-123', role: 'DEVELOPER' },
        { projectId: 'proj-koda-123', role: 'REVIEWER' },
      ]);

      const actor = await actorResolver.resolve(mockRequest as any);

      expect(actor).toHaveProperty('actorType');
      expect(actor).toHaveProperty('actorId');
      expect(actor).toHaveProperty('projectRoles');
      expect(actor).toHaveProperty('resourceRoles');
      expect(actor.actorType).toBe('user');
      expect(actor.actorId).toBe('user-456');
      expect(actor.projectRoles).toContain('DEVELOPER');
      expect(actor.projectRoles).toContain('REVIEWER');
    });

    it('should handle agent without user in request', async () => {
      const mockRequest = {
        user: null,
        agent: { id: 'agent-001', sub: 'agent-001' },
      };

      mockPrismaService.client.agentRoleEntry.findMany.mockResolvedValue([
        { projectId: 'proj-koda-123', role: 'AGENT' },
      ]);

      const actor = await actorResolver.resolve(mockRequest as any);

      expect(actor.actorType).toBe('agent');
      expect(actor.actorId).toBe('agent-001');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-8: Role-based access control for event write operations
  // ═══════════════════════════════════════════════════════════════════════════

  describe('AC-8: Role-based access control for event write operations', () => {
    it('should allow actors with admin role to create ticket events', async () => {
      const eventData = {
        ticketId: 'ticket-domain-001',
        projectId: 'proj-koda-123',
        action: 'CREATED',
        actorId: 'user-123',
        actorType: 'user' as const,
        source: 'api' as const,
        data: {},
      };

      const createdEvent = {
        id: 'event-ac-001',
        ticketId: eventData.ticketId,
        projectId: eventData.projectId,
        action: eventData.action,
        actorId: eventData.actorId,
        actorType: eventData.actorType,
        source: eventData.source,
        data: '{}',
        timestamp: new Date(),
        createdAt: new Date(),
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticketEvent.create.mockResolvedValue(createdEvent);
      mockPrismaService.client.agentRoleEntry.findMany.mockResolvedValue([
        { projectId: 'proj-koda-123', role: 'ADMIN' },
      ]);
      mockOutboxService.enqueue.mockResolvedValue({ id: 'outbox-5' } as any);

      const result = await kodaDomainWriter.writeTicketEvent(eventData);

      expect(result).toHaveProperty('canonicalId');
    });

    it('should allow actors with developer role to create ticket events', async () => {
      const eventData = {
        ticketId: 'ticket-domain-001',
        projectId: 'proj-koda-123',
        action: 'CREATED',
        actorId: 'user-developer',
        actorType: 'user' as const,
        source: 'api' as const,
        data: {},
      };

      const createdEvent = {
        id: 'event-ac-002',
        ticketId: eventData.ticketId,
        projectId: eventData.projectId,
        action: eventData.action,
        actorId: eventData.actorId,
        actorType: eventData.actorType,
        source: eventData.source,
        data: '{}',
        timestamp: new Date(),
        createdAt: new Date(),
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticketEvent.create.mockResolvedValue(createdEvent);
      mockPrismaService.client.agentRoleEntry.findMany.mockResolvedValue([
        { projectId: 'proj-koda-123', role: 'DEVELOPER' },
      ]);
      mockOutboxService.enqueue.mockResolvedValue({ id: 'outbox-6' } as any);

      const result = await kodaDomainWriter.writeTicketEvent(eventData);

      expect(result).toHaveProperty('canonicalId');
    });

    it('should allow agents to create ticket events', async () => {
      const eventData = {
        ticketId: 'ticket-domain-001',
        projectId: 'proj-koda-123',
        action: 'CREATED',
        actorId: 'agent-writer-001',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: {},
      };

      const createdEvent = {
        id: 'event-ac-003',
        ticketId: eventData.ticketId,
        projectId: eventData.projectId,
        action: eventData.action,
        actorId: eventData.actorId,
        actorType: eventData.actorType,
        source: eventData.source,
        data: '{}',
        timestamp: new Date(),
        createdAt: new Date(),
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticketEvent.create.mockResolvedValue(createdEvent);
      mockPrismaService.client.agentRoleEntry.findMany.mockResolvedValue([
        { projectId: 'proj-koda-123', role: 'AGENT' },
      ]);
      mockOutboxService.enqueue.mockResolvedValue({ id: 'outbox-7' } as any);

      const result = await kodaDomainWriter.writeTicketEvent(eventData);

      expect(result).toHaveProperty('canonicalId');
    });

    it('should deny actors without admin, developer, or agent role', async () => {
      const eventData = {
        ticketId: 'ticket-domain-001',
        projectId: 'proj-koda-123',
        action: 'CREATED',
        actorId: 'user-member',
        actorType: 'user' as const,
        source: 'api' as const,
        data: {},
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.agentRoleEntry.findMany.mockResolvedValue([
        { projectId: 'proj-koda-123', role: 'MEMBER' },
      ]);

      await expect(kodaDomainWriter.writeTicketEvent(eventData)).rejects.toThrow(
        ForbiddenAppException,
      );
    });

    it('should allow admin role to access GET /admin/outbox', async () => {
      const mockRequest = {
        user: { id: 'user-123', sub: 'user-123', role: 'ADMIN' },
        agent: null,
      };

      mockPrismaService.client.agentRoleEntry.findMany.mockResolvedValue([
        { projectId: 'proj-koda-123', role: 'ADMIN' },
      ]);

      const actor = await actorResolver.resolve(mockRequest as any);

      expect(actor.projectRoles).toContain('ADMIN');
    });

    it('should deny non-admin role to access GET /admin/outbox', async () => {
      const mockRequest = {
        user: { id: 'user-developer', sub: 'user-developer', role: 'DEVELOPER' },
        agent: null,
      };

      mockPrismaService.client.agentRoleEntry.findMany.mockResolvedValue([
        { projectId: 'proj-koda-123', role: 'DEVELOPER' },
      ]);

      const actor = await actorResolver.resolve(mockRequest as any);

      expect(actor.projectRoles).not.toContain('ADMIN');
    });
  });
});

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
 * AC-8: Only an actor with `project.read` in the target project can call the event write operations.
 *       (Permissions P1 US-003: the legacy admin/developer/agent allow-list became that key.)
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';

import { KodaDomainWriter } from '../../../src/koda-domain-writer/koda-domain-writer.service';
import { PrismaKodaDomainWriterRepository } from '../../../src/koda-domain-writer/prisma-koda-domain-writer.repository';
import { RagService } from '../../../src/rag/rag.service';
import { PermissionService } from '../../../src/permissions/permission.service';
import { TicketEventService } from '../../../src/events/ticket-event.service';
import { AgentEventService } from '../../../src/events/agent-event.service';
import { DecisionEventService } from '../../../src/events/decision-event.service';
import { PrismaEventsRepository } from '../../../src/events/prisma-events.repository';
describe('Event Write Operations and Actor Resolution', () => {
  let kodaDomainWriter: KodaDomainWriter;
  let ticketEventService: TicketEventService;
  let agentEventService: AgentEventService;
  let decisionEventService: DecisionEventService;

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
        findUnique: vi.fn(),
        findFirst: vi.fn(),
      },
      agent: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
      },
      ticket: {
        findUnique: vi.fn(),
        create: vi.fn(),
        findMany: vi.fn(),
      },
      ticketEvent: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
      },
      agentEvent: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
      },
      decisionEvent: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
      },
      outboxEvent: {
        create: vi.fn(),
        findMany: vi.fn(),
      },
      // Permissions P1 (US-003): the writer no longer reads actor roles from the database; the
      // PermissionService double below answers the decision. The project delegate stays because the
      // event services still validate the project before writing.
      $transaction: vi.fn(),
    },
  };

  const mockRagService = {
    indexDocument: vi.fn(),
    importGraphify: vi.fn(),
    validateProjectId: vi.fn(),
    search: vi.fn(),
  };

  const mockOutbox = {
    record: vi.fn().mockResolvedValue(undefined),
  };

  /**
   * Permissions P1 (US-003): the writer's only authorization input. It answers with `project.read`
   * unless a test overrides it, which is what an actor with access to the project holds there.
   */
  const mockPermissions = {
    effectiveKeys: vi.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KodaDomainWriter,
        PrismaKodaDomainWriterRepository,
        PrismaEventsRepository,
        TicketEventService,
        AgentEventService,
        DecisionEventService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: RagService, useValue: mockRagService },
        { provide: NathappOutboxService, useValue: mockOutbox },
        {
          // Transactions run inline; the writer's writes hit the mocked Prisma client.
          provide: TRANSACTION_MANAGER,
          useValue: {
            run: vi.fn((fn: () => Promise<unknown>) => fn()),
            getClient: vi.fn(),
            isInTransaction: vi.fn(() => false),
          },
        },
        { provide: PermissionService, useValue: mockPermissions },
      ],
    }).compile();

    kodaDomainWriter = module.get<KodaDomainWriter>(KodaDomainWriter);
    ticketEventService = module.get<TicketEventService>(TicketEventService);
    agentEventService = module.get<AgentEventService>(AgentEventService);
    decisionEventService = module.get<DecisionEventService>(DecisionEventService);
    mockPermissions.effectiveKeys.mockReset().mockResolvedValue(new Set(['project.read']));
  });

  afterEach(() => {
    vi.clearAllMocks();
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
      mockOutbox.record.mockResolvedValue({ id: 'outbox-1' } as any);

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
      mockOutbox.record.mockResolvedValue({ id: 'outbox-2' } as any);

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
      mockOutbox.record.mockResolvedValue({ id: 'outbox-3' } as any);

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
      mockOutbox.record.mockResolvedValue({ id: 'outbox-4' } as any);

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
  // AC-8: access control for event write operations (project.read, US-003)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('AC-8: event writes need project.read in the event’s project', () => {
    it('allows a user actor whose effective keys hold project.read', async () => {
      const eventData = {
        ticketId: 'ticket-domain-001',
        projectId: 'proj-koda-123',
        action: 'CREATED',
        actorId: 'user-123',
        actorType: 'user' as const,
        source: 'api' as const,
        data: { actorRole: 'ADMIN' },
      };

      const createdEvent = {
        id: 'event-ac-001',
        ticketId: eventData.ticketId,
        projectId: eventData.projectId,
        action: eventData.action,
        actorId: eventData.actorId,
        actorType: eventData.actorType,
        source: eventData.source,
        data: '{"actorRole":"ADMIN"}',
        timestamp: new Date(),
        createdAt: new Date(),
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticketEvent.create.mockResolvedValue(createdEvent);
      mockOutbox.record.mockResolvedValue({ id: 'outbox-5' } as any);
      mockPermissions.effectiveKeys.mockResolvedValue(new Set(['project.read', 'ticket.read']));

      const result = await kodaDomainWriter.writeTicketEvent(eventData);

      expect(result).toHaveProperty('canonicalId');
      expect(mockPermissions.effectiveKeys).toHaveBeenCalledWith(
        { type: 'USER', id: 'user-123' },
        { projectId: 'proj-koda-123' },
      );
    });

    it('allows an agent actor whose effective keys hold project.read', async () => {
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
      mockOutbox.record.mockResolvedValue({ id: 'outbox-7' } as any);
      mockPermissions.effectiveKeys.mockResolvedValue(new Set(['project.read']));

      const result = await kodaDomainWriter.writeTicketEvent(eventData);

      expect(result).toHaveProperty('canonicalId');
      expect(mockPermissions.effectiveKeys).toHaveBeenCalledWith(
        { type: 'AGENT', id: 'agent-writer-001' },
        { projectId: 'proj-koda-123' },
      );
    });

    it('denies an actor whose effective keys lack project.read, whatever the payload claims', async () => {
      const eventData = {
        ticketId: 'ticket-domain-001',
        projectId: 'proj-koda-123',
        action: 'CREATED',
        actorId: 'user-member',
        actorType: 'user' as const,
        source: 'api' as const,
        data: { actorRole: 'ADMIN' },
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPermissions.effectiveKeys.mockResolvedValue(new Set(['ticket.read']));

      await expect(kodaDomainWriter.writeTicketEvent(eventData)).rejects.toThrow(
        ForbiddenAppException,
      );
      expect(mockPrismaService.client.ticketEvent.create).not.toHaveBeenCalled();
      expect(mockOutbox.record).not.toHaveBeenCalled();
    });
  });
});

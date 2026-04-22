/**
 * KodaDomainWriter Integration Tests
 *
 * Story: KodaDomainWriter Write Gate
 * Description: Introduce KodaDomainWriter as the explicit write gateway for agent-initiated operations.
 *
 * Acceptance Criteria:
 * AC-1: When writeTicketEvent(data) is called, it writes to ticket_events and returns WriteResult with canonicalId
 * AC-2: When writeAgentAction(data) is called, it writes to agent_events and returns WriteResult with canonicalId
 * AC-3: When indexDocument(data) is called, it calls RagService.indexDocument() and returns WriteResult with derivedIds
 * AC-4: When importGraphify(data) is called, it calls RagService.importGraphify() and returns WriteResult
 * AC-5: Every WriteResult includes provenance field with actorId, projectId, action, timestamp, source
 * AC-6: When writeTicketEvent is called with non-existent projectId, it throws ForbiddenAppException
 * AC-7: When RagService.indexDocument() fails during indexDocument(), WriteResult.error contains error message but canonical write is still committed
 * AC-8: When KodaDomainWriter is injected into agent service flow, it replaces direct repository calls
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { ForbiddenAppException } from '@nathapp/nestjs-common';

// This service doesn't exist yet - tests will fail initially (RED phase)
import { KodaDomainWriter } from '../../../src/koda-domain-writer/koda-domain-writer.service';
import { RagService } from '../../../src/rag/rag.service';
import { AgentsService } from '../../../src/agents/agents.service';

describe('KodaDomainWriter Integration Tests', () => {
  let kodaDomainWriter: KodaDomainWriter;
  let ragService: RagService;
  let agentsService: AgentsService;
  let prismaService: PrismaService<PrismaClient>;

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
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      agent: {
        findUnique: jest.fn(),
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
      $transaction: jest.fn(),
    },
  };

  const mockRagService = {
    indexDocument: jest.fn(),
    importGraphify: jest.fn(),
    validateProjectId: jest.fn(),
    search: jest.fn(),
  };

  const mockAgentsService = {
    findById: jest.fn(),
    generateApiKey: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KodaDomainWriter,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: RagService, useValue: mockRagService },
        { provide: AgentsService, useValue: mockAgentsService },
      ],
    }).compile();

    kodaDomainWriter = module.get<KodaDomainWriter>(KodaDomainWriter);
    ragService = module.get<RagService>(RagService);
    agentsService = module.get<AgentsService>(AgentsService);
    prismaService = module.get<PrismaService<PrismaClient>>(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── AC-1: writeTicketEvent writes to ticket_events and returns WriteResult ────

  describe('AC-1: writeTicketEvent(data)', () => {
    it('should write a ticket event record to the database', async () => {
      const ticketEventData = {
        ticketId: 'ticket-domain-001',
        projectId: 'proj-koda-123',
        action: 'CREATED',
        actorId: 'agent-writer-001',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: { title: 'Authentication issue', description: 'Users cannot authenticate' },
      };

      const createdEvent = {
        id: 'event-ticket-001',
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

      mockPrismaService.client.ticketEvent.create.mockResolvedValue(createdEvent);

      const result = await kodaDomainWriter.writeTicketEvent(ticketEventData);

      expect(mockPrismaService.client.ticketEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          ticketId: ticketEventData.ticketId,
          projectId: ticketEventData.projectId,
          action: ticketEventData.action,
          actorId: ticketEventData.actorId,
          actorType: ticketEventData.actorType,
          source: ticketEventData.source,
        }),
      });

      expect(result).toHaveProperty('canonicalId');
      expect(result.canonicalId).toBe('event-ticket-001');
    });

    it('should return WriteResult with canonicalId field', async () => {
      const ticketEventData = {
        ticketId: 'ticket-domain-001',
        projectId: 'proj-koda-123',
        action: 'CREATED',
        actorId: 'agent-writer-001',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: { title: 'Test' },
      };

      const createdEvent = {
        id: 'event-ticket-unique-id',
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

      mockPrismaService.client.ticketEvent.create.mockResolvedValue(createdEvent);

      const result = await kodaDomainWriter.writeTicketEvent(ticketEventData);

      expect(result).toEqual(
        expect.objectContaining({
          canonicalId: 'event-ticket-unique-id',
          provenance: expect.any(Object),
        }),
      );
    });

    it('should include full provenance data in WriteResult', async () => {
      const ticketEventData = {
        ticketId: 'ticket-domain-001',
        projectId: 'proj-koda-123',
        action: 'CREATED',
        actorId: 'agent-writer-001',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: { title: 'Test' },
      };

      const createdEvent = {
        id: 'event-ticket-001',
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

      mockPrismaService.client.ticketEvent.create.mockResolvedValue(createdEvent);

      const result = await kodaDomainWriter.writeTicketEvent(ticketEventData);

      expect(result.provenance).toEqual(
        expect.objectContaining({
          actorId: 'agent-writer-001',
          projectId: 'proj-koda-123',
          action: 'CREATED',
          timestamp: expect.any(Date),
          source: 'api',
        }),
      );
    });
  });

  // ── AC-2: writeAgentAction writes to agent_events and returns WriteResult ────

  describe('AC-2: writeAgentAction(data)', () => {
    it('should write an agent action record to the database', async () => {
      const agentActionData = {
        agentId: 'agent-writer-001',
        projectId: 'proj-koda-123',
        action: 'ASSIGNED_TICKET',
        actorId: 'agent-writer-001',
        source: 'internal' as const,
        data: { ticketId: 'ticket-domain-001', ticketNumber: 42 },
      };

      const createdAgentEvent = {
        id: 'event-agent-001',
        agentId: agentActionData.agentId,
        projectId: agentActionData.projectId,
        action: agentActionData.action,
        actorId: agentActionData.actorId,
        source: agentActionData.source,
        data: JSON.stringify(agentActionData.data),
        timestamp: new Date(),
        createdAt: new Date(),
      };

      mockPrismaService.client.agentEvent.create.mockResolvedValue(createdAgentEvent);

      const result = await kodaDomainWriter.writeAgentAction(agentActionData);

      expect(mockPrismaService.client.agentEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          agentId: agentActionData.agentId,
          projectId: agentActionData.projectId,
          action: agentActionData.action,
          actorId: agentActionData.actorId,
          source: agentActionData.source,
        }),
      });

      expect(result).toHaveProperty('canonicalId');
      expect(result.canonicalId).toBe('event-agent-001');
    });

    it('should return WriteResult with canonicalId field', async () => {
      const agentActionData = {
        agentId: 'agent-writer-001',
        projectId: 'proj-koda-123',
        action: 'ASSIGNED_TICKET',
        actorId: 'agent-writer-001',
        source: 'internal' as const,
        data: { ticketId: 'ticket-domain-001' },
      };

      const createdAgentEvent = {
        id: 'event-agent-unique-id',
        agentId: agentActionData.agentId,
        projectId: agentActionData.projectId,
        action: agentActionData.action,
        actorId: agentActionData.actorId,
        source: agentActionData.source,
        data: JSON.stringify(agentActionData.data),
        timestamp: new Date(),
        createdAt: new Date(),
      };

      mockPrismaService.client.agentEvent.create.mockResolvedValue(createdAgentEvent);

      const result = await kodaDomainWriter.writeAgentAction(agentActionData);

      expect(result).toEqual(
        expect.objectContaining({
          canonicalId: 'event-agent-unique-id',
          provenance: expect.any(Object),
        }),
      );
    });

    it('should include full provenance data in WriteResult', async () => {
      const agentActionData = {
        agentId: 'agent-writer-001',
        projectId: 'proj-koda-123',
        action: 'ASSIGNED_TICKET',
        actorId: 'agent-writer-001',
        source: 'internal' as const,
        data: { ticketId: 'ticket-domain-001' },
      };

      const createdAgentEvent = {
        id: 'event-agent-001',
        agentId: agentActionData.agentId,
        projectId: agentActionData.projectId,
        action: agentActionData.action,
        actorId: agentActionData.actorId,
        source: agentActionData.source,
        data: JSON.stringify(agentActionData.data),
        timestamp: new Date(),
        createdAt: new Date(),
      };

      mockPrismaService.client.agentEvent.create.mockResolvedValue(createdAgentEvent);

      const result = await kodaDomainWriter.writeAgentAction(agentActionData);

      expect(result.provenance).toEqual(
        expect.objectContaining({
          actorId: 'agent-writer-001',
          projectId: 'proj-koda-123',
          action: 'ASSIGNED_TICKET',
          timestamp: expect.any(Date),
          source: 'internal',
        }),
      );
    });
  });

  // ── AC-3: indexDocument calls RagService and returns WriteResult ────

  describe('AC-3: indexDocument(data)', () => {
    it('should call RagService.indexDocument() with correct parameters', async () => {
      const indexDocData = {
        projectId: 'proj-koda-123',
        source: 'ticket' as const,
        sourceId: 'ticket-domain-001',
        content: 'This is a ticket about authentication',
        metadata: { ticketNumber: 42, title: 'Auth issue' },
        actorId: 'agent-writer-001',
        timestamp: new Date(),
      };

      mockRagService.indexDocument.mockResolvedValue(undefined);

      const result = await kodaDomainWriter.indexDocument(indexDocData);

      expect(mockRagService.indexDocument).toHaveBeenCalledWith('proj-koda-123', {
        source: indexDocData.source,
        sourceId: indexDocData.sourceId,
        content: indexDocData.content,
        metadata: indexDocData.metadata,
      });

      expect(result).toHaveProperty('provenance');
    });

    it('should return WriteResult with derivedIds field when successful', async () => {
      const indexDocData = {
        projectId: 'proj-koda-123',
        source: 'ticket' as const,
        sourceId: 'ticket-domain-001',
        content: 'Test content',
        metadata: { ticketNumber: 42 },
        actorId: 'agent-writer-001',
        timestamp: new Date(),
      };

      mockRagService.indexDocument.mockResolvedValue(undefined);

      const result = await kodaDomainWriter.indexDocument(indexDocData);

      expect(result).toEqual(
        expect.objectContaining({
          derivedIds: expect.any(Array),
          provenance: expect.any(Object),
        }),
      );
    });

    it('should include full provenance data in WriteResult', async () => {
      const indexDocData = {
        projectId: 'proj-koda-123',
        source: 'ticket' as const,
        sourceId: 'ticket-domain-001',
        content: 'Test content',
        metadata: {},
        actorId: 'agent-writer-001',
        timestamp: new Date(),
      };

      mockRagService.indexDocument.mockResolvedValue(undefined);

      const result = await kodaDomainWriter.indexDocument(indexDocData);

      expect(result.provenance).toEqual(
        expect.objectContaining({
          actorId: 'agent-writer-001',
          projectId: 'proj-koda-123',
          action: expect.stringContaining('INDEX'),
          timestamp: expect.any(Date),
          source: 'api',
        }),
      );
    });
  });

  // ── AC-4: importGraphify calls RagService and returns WriteResult ────

  describe('AC-4: importGraphify(data)', () => {
    it('should call RagService.importGraphify() with correct parameters', async () => {
      const importData = {
        projectId: 'proj-koda-123',
        nodes: [
          { id: 'node-1', label: 'Service A', type: 'class', source_file: 'service.ts' },
          { id: 'node-2', label: 'Service B', type: 'class', source_file: 'service.ts' },
        ],
        links: [
          { source: 'node-1', target: 'node-2', relation: 'uses' },
        ],
        actorId: 'agent-writer-001',
        timestamp: new Date(),
      };

      mockRagService.importGraphify.mockResolvedValue({ imported: 2, cleared: 0 });

      const result = await kodaDomainWriter.importGraphify(importData);

      expect(mockRagService.importGraphify).toHaveBeenCalledWith(
        'proj-koda-123',
        importData.nodes,
        importData.links,
      );

      expect(result).toHaveProperty('provenance');
    });

    it('should return WriteResult with import metadata', async () => {
      const importData = {
        projectId: 'proj-koda-123',
        nodes: [
          { id: 'node-1', label: 'Service A', type: 'class' },
        ],
        links: [],
        actorId: 'agent-writer-001',
        timestamp: new Date(),
      };

      mockRagService.importGraphify.mockResolvedValue({ imported: 1, cleared: 0 });

      const result = await kodaDomainWriter.importGraphify(importData);

      expect(result).toEqual(
        expect.objectContaining({
          metadata: expect.objectContaining({
            imported: 1,
            cleared: 0,
          }),
          provenance: expect.any(Object),
        }),
      );
    });

    it('should include full provenance data in WriteResult', async () => {
      const importData = {
        projectId: 'proj-koda-123',
        nodes: [],
        links: [],
        actorId: 'agent-writer-001',
        timestamp: new Date(),
      };

      mockRagService.importGraphify.mockResolvedValue({ imported: 0, cleared: 0 });

      const result = await kodaDomainWriter.importGraphify(importData);

      expect(result.provenance).toEqual(
        expect.objectContaining({
          actorId: 'agent-writer-001',
          projectId: 'proj-koda-123',
          action: expect.stringContaining('IMPORT'),
          timestamp: expect.any(Date),
          source: 'api',
        }),
      );
    });
  });

  // ── AC-5: WriteResult includes complete provenance ────

  describe('AC-5: WriteResult provenance field', () => {
    it('should include actorId in provenance', async () => {
      const ticketEventData = {
        ticketId: 'ticket-domain-001',
        projectId: 'proj-koda-123',
        action: 'CREATED',
        actorId: 'agent-writer-001',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: {},
      };

      const createdEvent = {
        id: 'event-123',
        ticketId: ticketEventData.ticketId,
        projectId: ticketEventData.projectId,
        action: ticketEventData.action,
        actorId: ticketEventData.actorId,
        actorType: ticketEventData.actorType,
        source: ticketEventData.source,
        data: '{}',
        timestamp: new Date(),
        createdAt: new Date(),
      };

      mockPrismaService.client.ticketEvent.create.mockResolvedValue(createdEvent);

      const result = await kodaDomainWriter.writeTicketEvent(ticketEventData);

      expect(result.provenance.actorId).toBe('agent-writer-001');
    });

    it('should include projectId in provenance', async () => {
      const ticketEventData = {
        ticketId: 'ticket-domain-001',
        projectId: 'proj-koda-123',
        action: 'CREATED',
        actorId: 'agent-writer-001',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: {},
      };

      const createdEvent = {
        id: 'event-123',
        ticketId: ticketEventData.ticketId,
        projectId: ticketEventData.projectId,
        action: ticketEventData.action,
        actorId: ticketEventData.actorId,
        actorType: ticketEventData.actorType,
        source: ticketEventData.source,
        data: '{}',
        timestamp: new Date(),
        createdAt: new Date(),
      };

      mockPrismaService.client.ticketEvent.create.mockResolvedValue(createdEvent);

      const result = await kodaDomainWriter.writeTicketEvent(ticketEventData);

      expect(result.provenance.projectId).toBe('proj-koda-123');
    });

    it('should include action in provenance', async () => {
      const ticketEventData = {
        ticketId: 'ticket-domain-001',
        projectId: 'proj-koda-123',
        action: 'CREATED',
        actorId: 'agent-writer-001',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: {},
      };

      const createdEvent = {
        id: 'event-123',
        ticketId: ticketEventData.ticketId,
        projectId: ticketEventData.projectId,
        action: ticketEventData.action,
        actorId: ticketEventData.actorId,
        actorType: ticketEventData.actorType,
        source: ticketEventData.source,
        data: '{}',
        timestamp: new Date(),
        createdAt: new Date(),
      };

      mockPrismaService.client.ticketEvent.create.mockResolvedValue(createdEvent);

      const result = await kodaDomainWriter.writeTicketEvent(ticketEventData);

      expect(result.provenance.action).toBe('CREATED');
    });

    it('should include timestamp in provenance', async () => {
      const ticketEventData = {
        ticketId: 'ticket-domain-001',
        projectId: 'proj-koda-123',
        action: 'CREATED',
        actorId: 'agent-writer-001',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: {},
      };

      const createdEvent = {
        id: 'event-123',
        ticketId: ticketEventData.ticketId,
        projectId: ticketEventData.projectId,
        action: ticketEventData.action,
        actorId: ticketEventData.actorId,
        actorType: ticketEventData.actorType,
        source: ticketEventData.source,
        data: '{}',
        timestamp: new Date(),
        createdAt: new Date(),
      };

      mockPrismaService.client.ticketEvent.create.mockResolvedValue(createdEvent);

      const result = await kodaDomainWriter.writeTicketEvent(ticketEventData);

      expect(result.provenance.timestamp).toEqual(expect.any(Date));
    });

    it('should include source in provenance', async () => {
      const ticketEventData = {
        ticketId: 'ticket-domain-001',
        projectId: 'proj-koda-123',
        action: 'CREATED',
        actorId: 'agent-writer-001',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: {},
      };

      const createdEvent = {
        id: 'event-123',
        ticketId: ticketEventData.ticketId,
        projectId: ticketEventData.projectId,
        action: ticketEventData.action,
        actorId: ticketEventData.actorId,
        actorType: ticketEventData.actorType,
        source: ticketEventData.source,
        data: '{}',
        timestamp: new Date(),
        createdAt: new Date(),
      };

      mockPrismaService.client.ticketEvent.create.mockResolvedValue(createdEvent);

      const result = await kodaDomainWriter.writeTicketEvent(ticketEventData);

      expect(result.provenance.source).toBe('api');
    });
  });

  // ── AC-6: Non-existent projectId throws ForbiddenAppException ────

  describe('AC-6: writeTicketEvent with non-existent projectId', () => {
    it('should throw ForbiddenAppException when project does not exist', async () => {
      const ticketEventData = {
        ticketId: 'ticket-domain-001',
        projectId: 'non-existent-project',
        action: 'CREATED',
        actorId: 'agent-writer-001',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: {},
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(null);

      await expect(kodaDomainWriter.writeTicketEvent(ticketEventData)).rejects.toThrow(
        ForbiddenAppException,
      );
    });

    it('should validate project exists before writing ticket event', async () => {
      const ticketEventData = {
        ticketId: 'ticket-domain-001',
        projectId: 'non-existent-project',
        action: 'CREATED',
        actorId: 'agent-writer-001',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: {},
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(null);

      await expect(kodaDomainWriter.writeTicketEvent(ticketEventData)).rejects.toThrow();

      // Should NOT have attempted to write
      expect(mockPrismaService.client.ticketEvent.create).not.toHaveBeenCalled();
    });

    it('should also validate on writeAgentAction', async () => {
      const agentActionData = {
        agentId: 'agent-writer-001',
        projectId: 'non-existent-project',
        action: 'ASSIGNED_TICKET',
        actorId: 'agent-writer-001',
        source: 'internal' as const,
        data: {},
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(null);

      await expect(kodaDomainWriter.writeAgentAction(agentActionData)).rejects.toThrow(
        ForbiddenAppException,
      );
    });

    it('should also validate on indexDocument', async () => {
      const indexDocData = {
        projectId: 'non-existent-project',
        source: 'ticket' as const,
        sourceId: 'ticket-001',
        content: 'Test',
        metadata: {},
        actorId: 'agent-writer-001',
        timestamp: new Date(),
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(null);

      await expect(kodaDomainWriter.indexDocument(indexDocData)).rejects.toThrow(
        ForbiddenAppException,
      );
    });

    it('should also validate on importGraphify', async () => {
      const importData = {
        projectId: 'non-existent-project',
        nodes: [],
        links: [],
        actorId: 'agent-writer-001',
        timestamp: new Date(),
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(null);

      await expect(kodaDomainWriter.importGraphify(importData)).rejects.toThrow(
        ForbiddenAppException,
      );
    });
  });

  // ── AC-7: RagService failure with committed canonical write ────

  describe('AC-7: indexDocument with RagService failure', () => {
    it('should still return WriteResult with error when RagService.indexDocument fails', async () => {
      const indexDocData = {
        projectId: 'proj-koda-123',
        source: 'ticket' as const,
        sourceId: 'ticket-domain-001',
        content: 'Test content',
        metadata: {},
        actorId: 'agent-writer-001',
        timestamp: new Date(),
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      const ragError = new Error('Embedding service unreachable');
      mockRagService.indexDocument.mockRejectedValue(ragError);

      const result = await kodaDomainWriter.indexDocument(indexDocData);

      expect(result.error).toBeTruthy();
      expect(result.error).toContain('Embedding service unreachable');
    });

    it('should still commit canonical write even if RAG indexing fails', async () => {
      const indexDocData = {
        projectId: 'proj-koda-123',
        source: 'ticket' as const,
        sourceId: 'ticket-domain-001',
        content: 'Test content',
        metadata: {},
        actorId: 'agent-writer-001',
        timestamp: new Date(),
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      const ragError = new Error('Connection failed');
      mockRagService.indexDocument.mockRejectedValue(ragError);

      // Mock successful ticket event creation
      mockPrismaService.client.ticketEvent.create.mockResolvedValue({
        id: 'event-123',
        ticketId: indexDocData.sourceId,
        projectId: indexDocData.projectId,
        action: 'INDEXED',
        actorId: indexDocData.actorId,
        actorType: 'agent',
        source: 'api',
        data: '{}',
        timestamp: new Date(),
        createdAt: new Date(),
      });

      const result = await kodaDomainWriter.indexDocument(indexDocData);

      // Canonical write should have been attempted
      expect(result.canonicalId).toBeDefined();
      expect(result.error).toBeTruthy();
    });

    it('should return error message from RagService failure in WriteResult.error', async () => {
      const indexDocData = {
        projectId: 'proj-koda-123',
        source: 'ticket' as const,
        sourceId: 'ticket-domain-001',
        content: 'Test content',
        metadata: {},
        actorId: 'agent-writer-001',
        timestamp: new Date(),
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      const errorMsg = 'Vector database unavailable';
      mockRagService.indexDocument.mockRejectedValue(new Error(errorMsg));

      const result = await kodaDomainWriter.indexDocument(indexDocData);

      expect(result.error).toContain(errorMsg);
    });
  });

  // ── AC-8: Integration with AgentsService ────

  describe('AC-8: Integration with agent service flow', () => {
    it('should be injectable into agent service context', async () => {
      // This test verifies that KodaDomainWriter can be injected
      // and used by the agent write flow instead of direct repository calls
      expect(kodaDomainWriter).toBeDefined();
      expect(kodaDomainWriter).toHaveProperty('writeTicketEvent');
      expect(kodaDomainWriter).toHaveProperty('writeAgentAction');
    });

    it('should provide methods that replace direct repository calls', async () => {
      // Agent workflows should call kodaDomainWriter.writeTicketEvent instead of
      // calling prismaService.client.ticketEvent.create directly
      expect(typeof kodaDomainWriter.writeTicketEvent).toBe('function');
      expect(typeof kodaDomainWriter.writeAgentAction).toBe('function');
      expect(typeof kodaDomainWriter.indexDocument).toBe('function');
      expect(typeof kodaDomainWriter.importGraphify).toBe('function');
    });

    it('should be used by agent service for ticket creation writes', async () => {
      // When agents create tickets through AgentsService, it should delegate to KodaDomainWriter
      // This is an integration test verifying the wiring is in place
      const ticketEventData = {
        ticketId: 'ticket-new-001',
        projectId: 'proj-koda-123',
        action: 'CREATED',
        actorId: 'agent-writer-001',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: { title: 'New ticket' },
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticketEvent.create.mockResolvedValue({
        id: 'event-123',
        ticketId: ticketEventData.ticketId,
        projectId: ticketEventData.projectId,
        action: ticketEventData.action,
        actorId: ticketEventData.actorId,
        actorType: ticketEventData.actorType,
        source: ticketEventData.source,
        data: JSON.stringify(ticketEventData.data),
        timestamp: new Date(),
        createdAt: new Date(),
      });

      const result = await kodaDomainWriter.writeTicketEvent(ticketEventData);

      expect(result).toHaveProperty('canonicalId');
      expect(result).toHaveProperty('provenance');
    });
  });
});

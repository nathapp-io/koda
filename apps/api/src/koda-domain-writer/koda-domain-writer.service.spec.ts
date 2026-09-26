import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';

import { KodaDomainWriter } from './koda-domain-writer.service';
import { PrismaKodaDomainWriterRepository } from './prisma-koda-domain-writer.repository';
import { RagService } from '../rag/rag.service';
import { AgentAuthProvider } from '../auth/agent-auth.provider';
import { TicketEventService } from '../events/ticket-event.service';
import { AgentEventService } from '../events/agent-event.service';
import { DecisionEventService } from '../events/decision-event.service';

describe('KodaDomainWriter Unit Tests', () => {
  let service: KodaDomainWriter;

  const mockWriterRepo = {
    findProjectById: jest.fn(),
  };

  const mockRagService = {
    indexDocument: jest.fn(),
    importGraphify: jest.fn(),
  };

  const outbox = {
    record: jest.fn().mockResolvedValue(undefined),
  };

  let depth = 0;
  const mockTxManager = {
    run: jest.fn(async <T>(fn: () => Promise<T>): Promise<T> => {
      depth += 1;
      try {
        return await fn();
      } finally {
        depth -= 1;
      }
    }),
    getClient: jest.fn(),
    isInTransaction: jest.fn(() => depth > 0),
  };

  const mockAgentAuthProvider = {
    loadAgentRoles: jest.fn().mockResolvedValue(['AGENT']),
    buildPrincipal: jest.fn(),
    invalidateByTag: jest.fn(),
  };

  const mockTicketEventService = {
    create: jest.fn(),
  };

  const mockAgentEventService = {
    create: jest.fn(),
  };

  const mockDecisionEventService = {
    create: jest.fn(),
  };

  beforeEach(async () => {
    depth = 0;
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KodaDomainWriter,
        { provide: PrismaKodaDomainWriterRepository, useValue: mockWriterRepo },
        { provide: RagService, useValue: mockRagService },
        { provide: NathappOutboxService, useValue: outbox },
        { provide: TRANSACTION_MANAGER, useValue: mockTxManager },
        { provide: AgentAuthProvider, useValue: mockAgentAuthProvider },
        { provide: TicketEventService, useValue: mockTicketEventService },
        { provide: AgentEventService, useValue: mockAgentEventService },
        { provide: DecisionEventService, useValue: mockDecisionEventService },
      ],
    }).compile();

    service = module.get<KodaDomainWriter>(KodaDomainWriter);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('writeTicketEvent', () => {
    it('should be defined', () => {
      expect(service.writeTicketEvent).toBeDefined();
      expect(typeof service.writeTicketEvent).toBe('function');
    });

    it('should require projectId parameter', async () => {
      const invalidData = {
        ticketId: 'ticket-001',
        projectId: '',
        action: 'CREATED',
        actorId: 'agent-001',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: {},
      };

      await expect(service.writeTicketEvent(invalidData)).rejects.toThrow();
    });

    describe('project guard', () => {
      it('should throw ForbiddenAppException when project does not exist', async () => {
        mockWriterRepo.findProjectById.mockResolvedValue(null);

        const data = {
          ticketId: 'ticket-001',
          projectId: 'nonexistent-project',
          action: 'TICKET_CREATED',
          actorId: 'agent-001',
          actorType: 'agent' as const,
          source: 'api' as const,
          data: {},
        };

        await expect(service.writeTicketEvent(data)).rejects.toBeInstanceOf(ForbiddenAppException);
      });
    });

    it('should validate project exists', async () => {
      const data = {
        ticketId: 'ticket-001',
        projectId: 'proj-nonexistent',
        action: 'CREATED',
        actorId: 'agent-001',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: {},
      };

      mockTicketEventService.create.mockRejectedValue(new ForbiddenAppException({}, 'events'));

      await expect(service.writeTicketEvent(data)).rejects.toThrow(ForbiddenAppException);
    });

    it('should throw if ticketId is missing', async () => {
      const data = {
        ticketId: '',
        projectId: 'proj-123',
        action: 'CREATED',
        actorId: 'agent-001',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: {},
      };

      await expect(service.writeTicketEvent(data)).rejects.toThrow();
    });

    it('should throw if action is missing', async () => {
      const data = {
        ticketId: 'ticket-001',
        projectId: 'proj-123',
        action: '',
        actorId: 'agent-001',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: {},
      };

      await expect(service.writeTicketEvent(data)).rejects.toThrow();
    });

    it('should throw if actorId is missing', async () => {
      const data = {
        ticketId: 'ticket-001',
        projectId: 'proj-123',
        action: 'CREATED',
        actorId: '',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: {},
      };

      await expect(service.writeTicketEvent(data)).rejects.toThrow();
    });
  });

  describe('writeAgentAction', () => {
    it('should be defined', () => {
      expect(service.writeAgentAction).toBeDefined();
      expect(typeof service.writeAgentAction).toBe('function');
    });

    it('should require projectId parameter', async () => {
      const invalidData = {
        agentId: 'agent-001',
        projectId: '',
        action: 'ASSIGNED_TICKET',
        actorId: 'agent-001',
        source: 'internal' as const,
        data: {},
      };

      await expect(service.writeAgentAction(invalidData)).rejects.toThrow();
    });

    describe('project guard', () => {
      it('should throw ForbiddenAppException when project does not exist', async () => {
        mockWriterRepo.findProjectById.mockResolvedValue(null);

        const data = {
          agentId: 'agent-001',
          projectId: 'nonexistent-project',
          action: 'DIAGNOSE',
          actorId: 'agent-001',
          source: 'api' as const,
          data: {},
        };

        await expect(service.writeAgentAction(data)).rejects.toBeInstanceOf(ForbiddenAppException);
      });
    });

    it('should validate project exists', async () => {
      const data = {
        agentId: 'agent-001',
        projectId: 'proj-nonexistent',
        action: 'ASSIGNED_TICKET',
        actorId: 'agent-001',
        source: 'internal' as const,
        data: {},
      };

      mockAgentEventService.create.mockRejectedValue(new ForbiddenAppException({}, 'events'));

      await expect(service.writeAgentAction(data)).rejects.toThrow(ForbiddenAppException);
    });

    it('should throw if agentId is missing', async () => {
      const data = {
        agentId: '',
        projectId: 'proj-123',
        action: 'ASSIGNED_TICKET',
        actorId: 'agent-001',
        source: 'internal' as const,
        data: {},
      };

      await expect(service.writeAgentAction(data)).rejects.toThrow();
    });
  });

  describe('writeDecisionEvent', () => {
    it('should be defined', () => {
      expect(service.writeDecisionEvent).toBeDefined();
      expect(typeof service.writeDecisionEvent).toBe('function');
    });

    it('should require projectId parameter', async () => {
      const data = {
        projectId: '',
        agentId: 'agent-001',
        action: 'DECIDE',
        decision: 'approved' as const,
        rationale: null,
        source: 'api' as const,
        data: {},
      };

      await expect(service.writeDecisionEvent(data)).rejects.toThrow();
    });

    it('should require agentId parameter', async () => {
      const data = {
        projectId: 'proj-123',
        agentId: '',
        action: 'DECIDE',
        decision: 'approved' as const,
        rationale: null,
        source: 'api' as const,
        data: {},
      };

      await expect(service.writeDecisionEvent(data)).rejects.toThrow();
    });

    describe('project guard', () => {
      it('should throw ForbiddenAppException when project does not exist', async () => {
        mockWriterRepo.findProjectById.mockResolvedValue(null);

        const data = {
          projectId: 'nonexistent-project',
          agentId: 'agent-001',
          action: 'DECIDE',
          decision: 'approved' as const,
          rationale: null,
          source: 'api' as const,
          data: {},
        };

        await expect(service.writeDecisionEvent(data)).rejects.toBeInstanceOf(ForbiddenAppException);
      });
    });
  });

  describe('indexDocument', () => {
    it('should be defined', () => {
      expect(service.indexDocument).toBeDefined();
      expect(typeof service.indexDocument).toBe('function');
    });

    it('should require projectId parameter', async () => {
      const invalidData = {
        projectId: '',
        source: 'ticket' as const,
        sourceId: 'ticket-001',
        content: 'Test',
        metadata: {},
        actorId: 'agent-001',
        timestamp: new Date(),
      };

      await expect(service.indexDocument(invalidData)).rejects.toThrow();
    });

    it('should validate project exists', async () => {
      const data = {
        projectId: 'proj-nonexistent',
        source: 'ticket' as const,
        sourceId: 'ticket-001',
        content: 'Test',
        metadata: {},
        actorId: 'agent-001',
        timestamp: new Date(),
      };

      mockTicketEventService.create.mockRejectedValue(new ForbiddenAppException({}, 'events'));

      await expect(service.indexDocument(data)).rejects.toThrow(ForbiddenAppException);
    });

    describe('project guard', () => {
      it('should throw ForbiddenAppException when project does not exist', async () => {
        mockWriterRepo.findProjectById.mockResolvedValue(null);

        const data = {
          projectId: 'nonexistent-project',
          source: 'ticket' as const,
          sourceId: 'ticket-001',
          content: 'Test content',
          metadata: {},
          actorId: 'agent-001',
          timestamp: new Date(),
        };

        await expect(service.indexDocument(data)).rejects.toBeInstanceOf(ForbiddenAppException);
      });
    });

    it('should require sourceId parameter', async () => {
      const data = {
        projectId: 'proj-123',
        source: 'ticket' as const,
        sourceId: '',
        content: 'Test',
        metadata: {},
        actorId: 'agent-001',
        timestamp: new Date(),
      };

      await expect(service.indexDocument(data)).rejects.toThrow();
    });

    it('should require content parameter', async () => {
      const data = {
        projectId: 'proj-123',
        source: 'ticket' as const,
        sourceId: 'ticket-001',
        content: '',
        metadata: {},
        actorId: 'agent-001',
        timestamp: new Date(),
      };

      await expect(service.indexDocument(data)).rejects.toThrow();
    });

    it('should reject non-ticket source for canonical indexing event', async () => {
      const data = {
        projectId: 'proj-123',
        source: 'doc' as const,
        sourceId: 'doc-001',
        content: 'Test',
        metadata: {},
        actorId: 'agent-001',
        timestamp: new Date(),
      };

      await expect(service.indexDocument(data)).rejects.toThrow();
    });
  });

  describe('importGraphify', () => {
    it('should be defined', () => {
      expect(service.importGraphify).toBeDefined();
      expect(typeof service.importGraphify).toBe('function');
    });

    it('should require projectId parameter', async () => {
      const invalidData = {
        projectId: '',
        nodes: [],
        links: [],
        actorId: 'agent-001',
        timestamp: new Date(),
      };

      await expect(service.importGraphify(invalidData)).rejects.toThrow();
    });

    it('should validate project exists', async () => {
      const data = {
        projectId: 'proj-nonexistent',
        nodes: [],
        links: [],
        actorId: 'agent-001',
        timestamp: new Date(),
      };

      mockWriterRepo.findProjectById.mockResolvedValue(null);

      await expect(service.importGraphify(data)).rejects.toThrow(ForbiddenAppException);
    });

    it('should accept empty nodes array', async () => {
      const data = {
        projectId: 'proj-123',
        nodes: [],
        links: [],
        actorId: 'agent-001',
        timestamp: new Date(),
      };

      mockWriterRepo.findProjectById.mockResolvedValue({ id: 'proj-123' });
      mockRagService.importGraphify.mockResolvedValue({ imported: 0, cleared: 0 });

      await expect(service.importGraphify(data)).resolves.toBeDefined();
    });
  });

  describe('H13: outbox payload carries the full event envelope', () => {
    const fixedTimestamp = new Date('2026-01-01T00:00:00Z');

    it('writeTicketEvent records the full ticket_event envelope', async () => {
      const data = {
        ticketId: 'ticket-001',
        projectId: 'proj-123',
        action: 'status_changed',
        actorId: 'agent-001',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: { newStatus: 'IN_PROGRESS' },
      };

      mockWriterRepo.findProjectById.mockResolvedValue({ id: 'proj-123', deletedAt: null });
      mockTicketEventService.create.mockResolvedValue({
        id: 'event-123',
        ticketId: data.ticketId,
        projectId: data.projectId,
        action: data.action,
        actorId: data.actorId,
        actorType: data.actorType,
        source: data.source,
        data: '{}',
        timestamp: fixedTimestamp,
        createdAt: fixedTimestamp,
      });

      await service.writeTicketEvent(data);

      expect(outbox.record).toHaveBeenCalledWith({
        type: 'ticket_event',
        payload: {
          id: 'event-123',
          type: 'ticket_event',
          action: 'status_changed',
          timestamp: '2026-01-01T00:00:00.000Z',
          ticketId: 'ticket-001',
          projectId: 'proj-123',
          actorId: 'agent-001',
          actorType: 'agent',
          data: { newStatus: 'IN_PROGRESS' },
        },
        metadata: { projectId: 'proj-123', eventId: 'event-123' },
      });
    });

    it('writeAgentAction records the full agent_event envelope', async () => {
      const data = {
        agentId: 'agent-001',
        projectId: 'proj-123',
        action: 'decision_made',
        actorId: 'agent-001',
        source: 'internal' as const,
        data: { decision: 'use_hot_path' },
      };

      mockWriterRepo.findProjectById.mockResolvedValue({ id: 'proj-123', deletedAt: null });
      mockAgentEventService.create.mockResolvedValue({
        id: 'event-agent-123',
        agentId: data.agentId,
        projectId: data.projectId,
        action: data.action,
        actorId: data.actorId,
        source: data.source,
        data: '{}',
        timestamp: fixedTimestamp,
        createdAt: fixedTimestamp,
      });

      await service.writeAgentAction(data);

      expect(outbox.record).toHaveBeenCalledWith({
        type: 'agent_event',
        payload: {
          id: 'event-agent-123',
          type: 'agent_event',
          action: 'decision_made',
          timestamp: '2026-01-01T00:00:00.000Z',
          agentId: 'agent-001',
          projectId: 'proj-123',
          actorId: 'agent-001',
          actorType: 'agent',
          data: { decision: 'use_hot_path' },
        },
        metadata: { projectId: 'proj-123', eventId: 'event-agent-123' },
      });
    });
  });

  describe('WriteResult structure', () => {
    it('writeTicketEvent result should include all required fields', async () => {
      const data = {
        ticketId: 'ticket-001',
        projectId: 'proj-123',
        action: 'CREATED',
        actorId: 'agent-001',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: {},
      };

      mockWriterRepo.findProjectById.mockResolvedValue({ id: 'proj-123', deletedAt: null });
      mockTicketEventService.create.mockResolvedValue({
        id: 'event-123',
        ticketId: data.ticketId,
        projectId: data.projectId,
        action: data.action,
        actorId: data.actorId,
        actorType: data.actorType,
        source: data.source,
        data: '{}',
        timestamp: new Date(),
        createdAt: new Date(),
      });

      const result = await service.writeTicketEvent(data);

      expect(result).toHaveProperty('canonicalId');
      expect(result).toHaveProperty('provenance');
      expect(result.provenance).toHaveProperty('actorId');
      expect(result.provenance).toHaveProperty('projectId');
      expect(result.provenance).toHaveProperty('action');
      expect(result.provenance).toHaveProperty('timestamp');
      expect(result.provenance).toHaveProperty('source');
      expect(outbox.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ticket_event',
          metadata: { projectId: 'proj-123', eventId: 'event-123' },
        }),
      );
    });

    it('writeAgentAction result should include all required fields', async () => {
      const data = {
        agentId: 'agent-001',
        projectId: 'proj-123',
        action: 'ASSIGNED_TICKET',
        actorId: 'agent-001',
        source: 'internal' as const,
        data: {},
      };

      mockWriterRepo.findProjectById.mockResolvedValue({ id: 'proj-123', deletedAt: null });
      mockAgentEventService.create.mockResolvedValue({
        id: 'event-123',
        agentId: data.agentId,
        projectId: data.projectId,
        action: data.action,
        actorId: data.actorId,
        source: data.source,
        data: '{}',
        timestamp: new Date(),
        createdAt: new Date(),
      });

      const result = await service.writeAgentAction(data);

      expect(result).toHaveProperty('canonicalId');
      expect(result).toHaveProperty('provenance');
      expect(result.provenance).toHaveProperty('actorId');
      expect(result.provenance).toHaveProperty('projectId');
      expect(result.provenance).toHaveProperty('action');
      expect(result.provenance).toHaveProperty('timestamp');
      expect(result.provenance).toHaveProperty('source');
      expect(outbox.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'agent_event',
          metadata: { projectId: 'proj-123', eventId: 'event-123' },
        }),
      );
    });

    it('indexDocument result should include derivedIds array', async () => {
      const data = {
        projectId: 'proj-123',
        source: 'ticket' as const,
        sourceId: 'ticket-001',
        content: 'Test content',
        metadata: {},
        actorId: 'agent-001',
        timestamp: new Date(),
      };

      mockWriterRepo.findProjectById.mockResolvedValue({ id: 'proj-123', deletedAt: null });
      mockTicketEventService.create.mockResolvedValue({
        id: 'event-index-001',
        ticketId: 'ticket-001',
        projectId: 'proj-123',
        action: 'INDEX_DOCUMENT',
        actorId: 'agent-001',
        actorType: 'agent',
        source: 'api',
        data: '{}',
        timestamp: new Date(),
        createdAt: new Date(),
      });
      mockRagService.indexDocument.mockResolvedValue(undefined);

      const result = await service.indexDocument(data);

      expect(result).toHaveProperty('derivedIds');
      expect(Array.isArray(result.derivedIds)).toBe(true);
      expect(result).toHaveProperty('provenance');
      expect(result.canonicalId).toBe('event-index-001');
      expect(outbox.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'document_indexed',
          metadata: { projectId: 'proj-123', eventId: 'event-index-001' },
        }),
      );
    });

    it('importGraphify result should include metadata about import', async () => {
      const data = {
        projectId: 'proj-123',
        nodes: [{ id: 'node-1', label: 'Test' }],
        links: [],
        actorId: 'agent-001',
        timestamp: new Date(),
      };

      mockWriterRepo.findProjectById.mockResolvedValue({ id: 'proj-123' });
      mockRagService.importGraphify.mockResolvedValue({ imported: 1, cleared: 0 });

      const result = await service.importGraphify(data);

      expect(result).toHaveProperty('metadata');
      expect(result.metadata).toHaveProperty('imported');
      expect(result.metadata).toHaveProperty('cleared');
      expect(result).toHaveProperty('provenance');
    });
  });

  describe('Error handling', () => {
    it('should not catch database errors - let them bubble up', async () => {
      const data = {
        ticketId: 'ticket-001',
        projectId: 'proj-123',
        action: 'CREATED',
        actorId: 'agent-001',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: {},
      };

      mockWriterRepo.findProjectById.mockResolvedValue({ id: 'proj-123', deletedAt: null });
      const dbError = new Error('Database connection failed');
      mockTicketEventService.create.mockRejectedValue(dbError);

      await expect(service.writeTicketEvent(data)).rejects.toThrow('Database connection failed');
    });

    it('should handle RagService errors gracefully in indexDocument', async () => {
      const data = {
        projectId: 'proj-123',
        source: 'ticket' as const,
        sourceId: 'ticket-001',
        content: 'Test',
        metadata: {},
        actorId: 'agent-001',
        timestamp: new Date(),
      };

      mockWriterRepo.findProjectById.mockResolvedValue({ id: 'proj-123', deletedAt: null });
      mockTicketEventService.create.mockResolvedValue({
        id: 'event-index-001',
        ticketId: 'ticket-001',
        projectId: 'proj-123',
        action: 'INDEX_DOCUMENT',
        actorId: 'agent-001',
        actorType: 'agent',
        source: 'api',
        data: '{}',
        timestamp: new Date(),
        createdAt: new Date(),
      });
      mockRagService.indexDocument.mockRejectedValue(new Error('RAG error'));

      const indexPromise = service.indexDocument(data);
      await expect(indexPromise).resolves.toBeDefined();
      const result = await indexPromise;
      expect(result).toBeDefined();
      expect(result.error).toBe('RAG error');
    });

    it('should bubble canonical write failures in indexDocument', async () => {
      const data = {
        projectId: 'proj-123',
        source: 'ticket' as const,
        sourceId: 'ticket-001',
        content: 'Test',
        metadata: {},
        actorId: 'agent-001',
        timestamp: new Date(),
      };

      mockTicketEventService.create.mockRejectedValue(new Error('Canonical write failed'));

      await expect(service.indexDocument(data)).rejects.toThrow('Canonical write failed');
    });
  });

  describe('transactional recording', () => {
    const ticketEventInput = {
      ticketId: 'ticket-001',
      projectId: 'proj-123',
      action: 'CREATED',
      actorId: 'agent-001',
      actorType: 'agent' as const,
      source: 'api' as const,
      data: {},
    };

    const agentActionInput = {
      agentId: 'agent-001',
      projectId: 'proj-123',
      action: 'ASSIGNED_TICKET',
      actorId: 'agent-001',
      source: 'api' as const,
      data: {},
    };

    const decisionInput = {
      projectId: 'proj-123',
      agentId: 'agent-001',
      action: 'DECIDE',
      decision: 'approved' as const,
      rationale: null,
      source: 'api' as const,
      data: {},
    };

    const indexInput = {
      projectId: 'proj-123',
      source: 'ticket' as const,
      sourceId: 'ticket-001',
      content: 'Test content',
      metadata: {},
      actorId: 'agent-001',
      timestamp: new Date(),
    };

    const eventCreateMocks = [
      mockTicketEventService.create,
      mockAgentEventService.create,
      mockDecisionEventService.create,
    ];

    beforeEach(() => {
      mockWriterRepo.findProjectById.mockResolvedValue({ id: 'proj-123', deletedAt: null });
    });

    it.each([
      ['writeTicketEvent', () => service.writeTicketEvent(ticketEventInput)],
      ['writeAgentAction', () => service.writeAgentAction(agentActionInput)],
      ['writeDecisionEvent', () => service.writeDecisionEvent(decisionInput)],
      ['indexDocument', () => service.indexDocument(indexInput)],
    ])('%s creates the event row and records the outbox row in one transaction', async (_name, call) => {
      const depthAtWrite: number[] = [];
      eventCreateMocks.forEach((m) => m.mockImplementation(async () => { depthAtWrite.push(depth); return { id: 'evt-1', action: 'a', timestamp: new Date() }; }));
      outbox.record.mockImplementation(async () => { depthAtWrite.push(depth); });

      await call();

      expect(depthAtWrite).toEqual([1, 1]);
    });

    it('indexDocument indexes into RAG only after the transaction commits', async () => {
      // indexDocument swallows RAG failures into WriteResult.error, so an
      // assertion inside the RAG mock would be swallowed too. Capture the
      // transaction depth instead and assert it after the call, where a
      // regression that moved the RAG call inside txManager.run still fails.
      let depthAtRag: number | undefined;
      mockTicketEventService.create.mockResolvedValue({ id: 'evt-1', action: 'a', timestamp: new Date() });
      mockRagService.indexDocument.mockImplementation(async () => { depthAtRag = depth; });

      await service.indexDocument(indexInput);

      expect(mockRagService.indexDocument).toHaveBeenCalled();
      expect(depthAtRag).toBe(0);
    });
  });
});

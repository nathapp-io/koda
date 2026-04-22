/**
 * KodaDomainWriter Unit Tests
 *
 * Tests the KodaDomainWriter service in isolation with mocked dependencies.
 * These tests focus on the service's public interface and error handling.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { ForbiddenAppException } from '@nathapp/nestjs-common';

// This service doesn't exist yet - tests will fail initially (RED phase)
import { KodaDomainWriter } from './koda-domain-writer.service';
import { RagService } from '../rag/rag.service';

describe('KodaDomainWriter Unit Tests', () => {
  let service: KodaDomainWriter;
  let prismaService: PrismaService<PrismaClient>;
  let ragService: RagService;

  const mockPrismaService = {
    client: {
      project: {
        findUnique: jest.fn(),
      },
      ticketEvent: {
        create: jest.fn(),
      },
      agentEvent: {
        create: jest.fn(),
      },
    },
  };

  const mockRagService = {
    indexDocument: jest.fn(),
    importGraphify: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KodaDomainWriter,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: RagService, useValue: mockRagService },
      ],
    }).compile();

    service = module.get<KodaDomainWriter>(KodaDomainWriter);
    prismaService = module.get<PrismaService<PrismaClient>>(PrismaService);
    ragService = module.get<RagService>(RagService);
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
        projectId: '', // empty
        action: 'CREATED',
        actorId: 'agent-001',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: {},
      };

      await expect(service.writeTicketEvent(invalidData)).rejects.toThrow();
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

      mockPrismaService.client.project.findUnique.mockResolvedValue(null);

      await expect(service.writeTicketEvent(data)).rejects.toThrow(ForbiddenAppException);
    });

    it('should throw if ticketId is missing', async () => {
      const data = {
        ticketId: '', // empty
        projectId: 'proj-123',
        action: 'CREATED',
        actorId: 'agent-001',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: {},
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue({ id: 'proj-123' });

      await expect(service.writeTicketEvent(data)).rejects.toThrow();
    });

    it('should throw if action is missing', async () => {
      const data = {
        ticketId: 'ticket-001',
        projectId: 'proj-123',
        action: '', // empty
        actorId: 'agent-001',
        actorType: 'agent' as const,
        source: 'api' as const,
        data: {},
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue({ id: 'proj-123' });

      await expect(service.writeTicketEvent(data)).rejects.toThrow();
    });

    it('should throw if actorId is missing', async () => {
      const data = {
        ticketId: 'ticket-001',
        projectId: 'proj-123',
        action: 'CREATED',
        actorId: '', // empty
        actorType: 'agent' as const,
        source: 'api' as const,
        data: {},
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue({ id: 'proj-123' });

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
        projectId: '', // empty
        action: 'ASSIGNED_TICKET',
        actorId: 'agent-001',
        source: 'internal' as const,
        data: {},
      };

      await expect(service.writeAgentAction(invalidData)).rejects.toThrow();
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

      mockPrismaService.client.project.findUnique.mockResolvedValue(null);

      await expect(service.writeAgentAction(data)).rejects.toThrow(ForbiddenAppException);
    });

    it('should throw if agentId is missing', async () => {
      const data = {
        agentId: '', // empty
        projectId: 'proj-123',
        action: 'ASSIGNED_TICKET',
        actorId: 'agent-001',
        source: 'internal' as const,
        data: {},
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue({ id: 'proj-123' });

      await expect(service.writeAgentAction(data)).rejects.toThrow();
    });
  });

  describe('indexDocument', () => {
    it('should be defined', () => {
      expect(service.indexDocument).toBeDefined();
      expect(typeof service.indexDocument).toBe('function');
    });

    it('should require projectId parameter', async () => {
      const invalidData = {
        projectId: '', // empty
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

      mockPrismaService.client.project.findUnique.mockResolvedValue(null);

      await expect(service.indexDocument(data)).rejects.toThrow(ForbiddenAppException);
    });

    it('should require sourceId parameter', async () => {
      const data = {
        projectId: 'proj-123',
        source: 'ticket' as const,
        sourceId: '', // empty
        content: 'Test',
        metadata: {},
        actorId: 'agent-001',
        timestamp: new Date(),
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue({ id: 'proj-123' });

      await expect(service.indexDocument(data)).rejects.toThrow();
    });

    it('should require content parameter', async () => {
      const data = {
        projectId: 'proj-123',
        source: 'ticket' as const,
        sourceId: 'ticket-001',
        content: '', // empty
        metadata: {},
        actorId: 'agent-001',
        timestamp: new Date(),
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue({ id: 'proj-123' });

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
        projectId: '', // empty
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

      mockPrismaService.client.project.findUnique.mockResolvedValue(null);

      await expect(service.importGraphify(data)).rejects.toThrow(ForbiddenAppException);
    });

    it('should accept empty nodes array', async () => {
      const data = {
        projectId: 'proj-123',
        nodes: [], // empty is ok
        links: [],
        actorId: 'agent-001',
        timestamp: new Date(),
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue({ id: 'proj-123' });
      mockRagService.importGraphify.mockResolvedValue({ imported: 0, cleared: 0 });

      // Should not throw
      await expect(service.importGraphify(data)).resolves.toBeDefined();
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

      mockPrismaService.client.project.findUnique.mockResolvedValue({ id: 'proj-123' });
      mockPrismaService.client.ticketEvent.create.mockResolvedValue({
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

      mockPrismaService.client.project.findUnique.mockResolvedValue({ id: 'proj-123' });
      mockPrismaService.client.agentEvent.create.mockResolvedValue({
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

      mockPrismaService.client.project.findUnique.mockResolvedValue({ id: 'proj-123' });
      mockRagService.indexDocument.mockResolvedValue(undefined);

      const result = await service.indexDocument(data);

      expect(result).toHaveProperty('derivedIds');
      expect(Array.isArray(result.derivedIds)).toBe(true);
      expect(result).toHaveProperty('provenance');
    });

    it('importGraphify result should include metadata about import', async () => {
      const data = {
        projectId: 'proj-123',
        nodes: [{ id: 'node-1', label: 'Test' }],
        links: [],
        actorId: 'agent-001',
        timestamp: new Date(),
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue({ id: 'proj-123' });
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

      mockPrismaService.client.project.findUnique.mockResolvedValue({ id: 'proj-123' });
      const dbError = new Error('Database connection failed');
      mockPrismaService.client.ticketEvent.create.mockRejectedValue(dbError);

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

      mockPrismaService.client.project.findUnique.mockResolvedValue({ id: 'proj-123' });
      mockRagService.indexDocument.mockRejectedValue(new Error('RAG error'));

      // Should not throw, but return error in result
      const indexPromise = service.indexDocument(data);
      await expect(indexPromise).resolves.toBeDefined();
      const result = await indexPromise;
      expect(result).toBeDefined();
    });
  });
});

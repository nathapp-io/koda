import {
  CanonicalStateService,
} from './canonical-state.service';
import { NotFoundAppException } from '@nathapp/nestjs-common';

describe('CanonicalStateService', () => {
  let service: CanonicalStateService;

  const mockPrismaClient = {
    project: {
      findUnique: jest.fn(),
    },
    ticket: {
      findMany: jest.fn(),
    },
    ticketEvent: {
      findMany: jest.fn(),
    },
    agentEvent: {
      findMany: jest.fn(),
    },
    decisionEvent: {
      findMany: jest.fn(),
    },
    memoryItem: {
      findMany: jest.fn(),
    },
  };

  const mockPrismaService = {
    client: mockPrismaClient,
  };

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new CanonicalStateService(mockPrismaService as any);

    jest.clearAllMocks();
  });

  const setupValidProject = () => {
    mockPrismaClient.project.findUnique.mockResolvedValue({
      id: 'project-123',
      slug: 'test-project',
      deletedAt: null,
    });
  };

  describe('AC-1: retrievedAt timestamp', () => {
    test('returns retrievedAt set to the server timestamp at snapshot creation', async () => {
      setupValidProject();
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);

      const before = new Date();
      const result = await service.getSnapshot({ projectId: 'project-123' });
      const after = new Date();

      expect(result.retrievedAt).toBeInstanceOf(Date);
      expect(result.retrievedAt.getTime()).toBeGreaterThanOrEqual(
        before.getTime(),
      );
      expect(result.retrievedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe('AC-2: tickets filtered by ticketIds', () => {
    test('returns only tickets belonging to the project and matching given IDs', async () => {
      setupValidProject();
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);

      const matchingTickets = [
        {
          id: 'ticket-1',
          title: 'Fix bug',
          status: 'IN_PROGRESS',
          priority: 'HIGH',
          assignedToUserId: 'user-1',
          assignedToAgentId: null,
          createdAt: new Date('2025-01-01'),
          updatedAt: new Date('2025-01-02'),
        },
        {
          id: 'ticket-3',
          title: 'Add feature',
          status: 'CREATED',
          priority: 'MEDIUM',
          assignedToUserId: null,
          assignedToAgentId: 'agent-1',
          createdAt: new Date('2025-01-03'),
          updatedAt: new Date('2025-01-04'),
        },
      ];

      mockPrismaClient.ticket.findMany.mockResolvedValue(matchingTickets);

      const result = await service.getSnapshot({
        projectId: 'project-123',
        ticketIds: ['ticket-1', 'ticket-3'],
      });

      expect(mockPrismaClient.ticket.findMany).toHaveBeenCalledWith({
        where: {
          projectId: 'project-123',
          id: { in: ['ticket-1', 'ticket-3'] },
          deletedAt: null,
        },
        select: {
          id: true,
          title: true,
          status: true,
          priority: true,
          assignedToUserId: true,
          assignedToAgentId: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      expect(result.tickets).toEqual(matchingTickets);
    });

    test('excludes soft-deleted tickets', async () => {
      setupValidProject();
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.ticket.findMany.mockResolvedValue([]);

      await service.getSnapshot({
        projectId: 'project-123',
        ticketIds: ['ticket-1'],
      });

      expect(mockPrismaClient.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            deletedAt: null,
          }),
        }),
      );
    });
  });

  describe('AC-3: empty or undefined ticketIds', () => {
    test('returns empty tickets array when ticketIds is empty array', async () => {
      setupValidProject();
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);

      const result = await service.getSnapshot({
        projectId: 'project-123',
        ticketIds: [],
      });

      expect(result.tickets).toEqual([]);
      expect(mockPrismaClient.ticket.findMany).not.toHaveBeenCalled();
    });

    test('returns empty tickets array when ticketIds is undefined', async () => {
      setupValidProject();
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);

      const result = await service.getSnapshot({
        projectId: 'project-123',
      });

      expect(result.tickets).toEqual([]);
      expect(mockPrismaClient.ticket.findMany).not.toHaveBeenCalled();
    });
  });

  describe('AC-4: timeWindow filters recentEvents', () => {
    test('returns only events within the time window, ordered by createdAt DESC', async () => {
      setupValidProject();
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);

      const jan1 = new Date('2025-01-01T00:00:00Z');
      const jan2 = new Date('2025-01-02T00:00:00Z');
      const jan3 = new Date('2025-01-03T00:00:00Z');

      const ticketEvents = [
        {
          id: 'te-1',
          projectId: 'project-123',
          actorId: 'actor-1',
          action: 'CREATED',
          data: '{"status":"CREATED"}',
          createdAt: jan2,
        },
      ];

      const agentEvents = [
        {
          id: 'ae-1',
          projectId: 'project-123',
          actorId: 'actor-2',
          action: 'decision_made',
          data: '{"decision":"approved"}',
          createdAt: jan3,
        },
      ];

      const decisionEvents = [
        {
          id: 'de-1',
          projectId: 'project-123',
          agentId: 'agent-1',
          action: 'decided',
          data: '{"reason":"test"}',
          createdAt: jan1,
        },
      ];

      mockPrismaClient.ticketEvent.findMany.mockResolvedValue(ticketEvents);
      mockPrismaClient.agentEvent.findMany.mockResolvedValue(agentEvents);
      mockPrismaClient.decisionEvent.findMany.mockResolvedValue(decisionEvents);

      const result = await service.getSnapshot({
        projectId: 'project-123',
        timeWindow: { from: jan1, to: jan3 },
      });

      // Should pass correct where clause with time window
      const expectedWhere = {
        projectId: 'project-123',
        createdAt: { gte: jan1, lte: jan3 },
      };

      expect(mockPrismaClient.ticketEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expectedWhere }),
      );
      expect(mockPrismaClient.agentEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expectedWhere }),
      );
      expect(mockPrismaClient.decisionEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expectedWhere }),
      );

      // Should have all three events
      expect(result.recentEvents).toHaveLength(3);

      // Should be ordered by createdAt DESC (jan3, jan2, jan1)
      const events = result.recentEvents;
      expect(events[0].createdAt).toEqual(jan3);
      expect(events[1].createdAt).toEqual(jan2);
      expect(events[2].createdAt).toEqual(jan1);
    });

    test('parses JSON data payload for events', async () => {
      setupValidProject();
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.ticketEvent.findMany.mockResolvedValue([
        {
          id: 'te-1',
          projectId: 'project-123',
          actorId: 'actor-1',
          action: 'CREATED',
          data: '{"status":"CREATED","by":"user-1"}',
          createdAt: new Date(),
        },
      ]);
      mockPrismaClient.agentEvent.findMany.mockResolvedValue([]);
      mockPrismaClient.decisionEvent.findMany.mockResolvedValue([]);

      const result = await service.getSnapshot({
        projectId: 'project-123',
        timeWindow: { from: new Date('2025-01-01') },
      });

      const parsedEvents = result.recentEvents;
      expect(parsedEvents[0].payload).toEqual({
        status: 'CREATED',
        by: 'user-1',
      });
    });

    test('handles unparseable JSON data gracefully', async () => {
      setupValidProject();
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.ticketEvent.findMany.mockResolvedValue([
        {
          id: 'te-1',
          projectId: 'project-123',
          actorId: 'actor-1',
          action: 'CREATED',
          data: 'not valid json',
          createdAt: new Date(),
        },
      ]);
      mockPrismaClient.agentEvent.findMany.mockResolvedValue([]);
      mockPrismaClient.decisionEvent.findMany.mockResolvedValue([]);

      const result = await service.getSnapshot({
        projectId: 'project-123',
        timeWindow: { from: new Date('2025-01-01') },
      });

      const unparseableEvents = result.recentEvents;
      expect(unparseableEvents[0].payload).toEqual({});
    });

    test('returns empty recentEvents when no timeWindow provided', async () => {
      setupValidProject();
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);

      const result = await service.getSnapshot({
        projectId: 'project-123',
      });

      expect(result.recentEvents).toEqual([]);
      expect(mockPrismaClient.ticketEvent.findMany).not.toHaveBeenCalled();
    });

    test('maps decision event agentId to actorId', async () => {
      setupValidProject();
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);
      mockPrismaClient.ticketEvent.findMany.mockResolvedValue([]);
      mockPrismaClient.agentEvent.findMany.mockResolvedValue([]);
      mockPrismaClient.decisionEvent.findMany.mockResolvedValue([
        {
          id: 'de-1',
          projectId: 'project-123',
          agentId: 'agent-42',
          action: 'decided',
          data: '{}',
          createdAt: new Date(),
        },
      ]);

      const result = await service.getSnapshot({
        projectId: 'project-123',
        timeWindow: { from: new Date('2025-01-01') },
      });

      const decisionMappedEvents = result.recentEvents;
      expect(decisionMappedEvents[0].actorId).toBe('agent-42');
      expect(decisionMappedEvents[0].eventType).toBe('decision_event');
    });
  });

  describe('AC-5: activeDecisions from MemoryItem', () => {
    test('populates activeDecisions from active MemoryItem rows with kind=DECISION and status=active', async () => {
      setupValidProject();

      const memoryRows = [
        {
          id: 'mem-1',
          predicate: 'architecture-choice',
          object: 'Use microservices',
          createdAt: new Date('2025-01-01'),
        },
        {
          id: 'mem-2',
          predicate: 'api-design',
          object: 'REST over GraphQL',
          createdAt: new Date('2025-01-02'),
        },
      ];

      mockPrismaClient.memoryItem.findMany.mockResolvedValue(memoryRows);

      const result = await service.getSnapshot({
        projectId: 'project-123',
      });

      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalledWith({
        where: {
          projectId: 'project-123',
          kind: 'DECISION',
          status: 'active',
          deletedAt: null,
        },
        select: {
          id: true,
          predicate: true,
          object: true,
          createdAt: true,
        },
      });

      expect(result.activeDecisions).toHaveLength(2);
      const decisions = result.activeDecisions;
      expect(decisions[0]).toEqual({
        id: 'mem-1',
        topic: 'architecture-choice',
        decision: 'Use microservices',
        rationale: null,
        createdAt: new Date('2025-01-01'),
      });
      expect(decisions[1]).toEqual({
        id: 'mem-2',
        topic: 'api-design',
        decision: 'REST over GraphQL',
        rationale: null,
        createdAt: new Date('2025-01-02'),
      });
    });

    test('returns empty array when no active decisions exist', async () => {
      setupValidProject();
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);

      const result = await service.getSnapshot({
        projectId: 'project-123',
      });

      expect(result.activeDecisions).toEqual([]);
    });

    test('excludes soft-deleted memory items', async () => {
      setupValidProject();
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);

      await service.getSnapshot({
        projectId: 'project-123',
      });

      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            deletedAt: null,
          }),
        }),
      );
    });
  });

  describe('AC-6: non-existent projectId', () => {
    test('throws NotFoundAppException when project does not exist', async () => {
      mockPrismaClient.project.findUnique.mockResolvedValue(null);

      await expect(
        service.getSnapshot({ projectId: 'nonexistent' }),
      ).rejects.toThrow(NotFoundAppException);
    });

    test('throws NotFoundAppException when project is soft-deleted', async () => {
      mockPrismaClient.project.findUnique.mockResolvedValue({
        id: 'project-deleted',
        slug: 'deleted-project',
        deletedAt: new Date(),
      });

      await expect(
        service.getSnapshot({ projectId: 'project-deleted' }),
      ).rejects.toThrow(NotFoundAppException);
    });
  });

  describe('AC-7: canonical Prisma reads only', () => {
    test('queries only Prisma models, no external stores', async () => {
      setupValidProject();
      mockPrismaClient.ticket.findMany.mockResolvedValue([]);
      mockPrismaClient.ticketEvent.findMany.mockResolvedValue([]);
      mockPrismaClient.agentEvent.findMany.mockResolvedValue([]);
      mockPrismaClient.decisionEvent.findMany.mockResolvedValue([]);
      mockPrismaClient.memoryItem.findMany.mockResolvedValue([]);

      await service.getSnapshot({
        projectId: 'project-123',
        ticketIds: ['ticket-1'],
        timeWindow: { from: new Date('2025-01-01') },
      });

      // Verify only Prisma reads were performed
      expect(mockPrismaClient.project.findUnique).toHaveBeenCalled();
      expect(mockPrismaClient.ticket.findMany).toHaveBeenCalled();
      expect(mockPrismaClient.ticketEvent.findMany).toHaveBeenCalled();
      expect(mockPrismaClient.agentEvent.findMany).toHaveBeenCalled();
      expect(mockPrismaClient.decisionEvent.findMany).toHaveBeenCalled();
      expect(mockPrismaClient.memoryItem.findMany).toHaveBeenCalled();

      // Verify no LanceDB, BM25, or entity graph queries exist in the service
      // (This is trivially satisfied since the service only injects PrismaService)
    });
  });
});

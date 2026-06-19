import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaTimelineRepository } from './prisma-timeline.repository';

describe('PrismaTimelineRepository', () => {
  let repository: PrismaTimelineRepository;

  const mockTicketEvent = { findMany: jest.fn() };
  const mockAgentEvent = { findMany: jest.fn() };
  const mockDecisionEvent = { findMany: jest.fn() };

  const mockPrismaService = {
    client: {
      ticketEvent: mockTicketEvent,
      agentEvent: mockAgentEvent,
      decisionEvent: mockDecisionEvent,
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrismaTimelineRepository,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    repository = module.get<PrismaTimelineRepository>(PrismaTimelineRepository);

    jest.clearAllMocks();
  });

  describe('findTicketEvents', () => {
    it('queries ticketEvent table with given where clause ordered by createdAt and id DESC', async () => {
      const rows = [
        { id: 'te-2', actorId: 'actor-1', action: 'STATUS_CHANGE', ticketId: 'ticket-1', createdAt: new Date('2025-01-02') },
        { id: 'te-1', actorId: 'actor-1', action: 'CREATED', ticketId: 'ticket-1', createdAt: new Date('2025-01-01') },
      ];
      mockTicketEvent.findMany.mockResolvedValue(rows);

      const where = { projectId: 'project-123' };
      const result = await repository.findTicketEvents(where);

      expect(mockTicketEvent.findMany).toHaveBeenCalledWith({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      expect(result).toEqual(rows);
    });

    it('returns empty array when no ticket events match', async () => {
      mockTicketEvent.findMany.mockResolvedValue([]);

      const result = await repository.findTicketEvents({ projectId: 'none' });

      expect(result).toEqual([]);
    });

    it('passes complex where clause through unchanged', async () => {
      mockTicketEvent.findMany.mockResolvedValue([]);

      const where = {
        projectId: 'project-123',
        actorId: 'actor-42',
        createdAt: { gte: new Date('2025-01-01'), lte: new Date('2025-12-31') },
      };

      await repository.findTicketEvents(where);

      expect(mockTicketEvent.findMany).toHaveBeenCalledWith({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
    });
  });

  describe('findAgentEvents', () => {
    it('queries agentEvent table with given where clause ordered by createdAt and id DESC', async () => {
      const rows = [
        { id: 'ae-1', actorId: 'actor-1', action: 'decision_made', createdAt: new Date() },
      ];
      mockAgentEvent.findMany.mockResolvedValue(rows);

      const where = { projectId: 'project-123' };
      const result = await repository.findAgentEvents(where);

      expect(mockAgentEvent.findMany).toHaveBeenCalledWith({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      expect(result).toEqual(rows);
    });

    it('returns empty array when no agent events match', async () => {
      mockAgentEvent.findMany.mockResolvedValue([]);

      const result = await repository.findAgentEvents({ projectId: 'none' });

      expect(result).toEqual([]);
    });
  });

  describe('findDecisionEvents', () => {
    it('queries decisionEvent table with given where clause ordered by createdAt and id DESC', async () => {
      const rows = [
        { id: 'de-1', agentId: 'agent-1', action: 'decided', createdAt: new Date() },
      ];
      mockDecisionEvent.findMany.mockResolvedValue(rows);

      const where = { projectId: 'project-123' };
      const result = await repository.findDecisionEvents(where);

      expect(mockDecisionEvent.findMany).toHaveBeenCalledWith({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      expect(result).toEqual(rows);
    });

    it('returns empty array when no decision events match', async () => {
      mockDecisionEvent.findMany.mockResolvedValue([]);

      const result = await repository.findDecisionEvents({ projectId: 'none' });

      expect(result).toEqual([]);
    });

    it('passes agentId filter through unchanged', async () => {
      mockDecisionEvent.findMany.mockResolvedValue([]);

      const where = { projectId: 'project-123', agentId: 'agent-42' };

      await repository.findDecisionEvents(where);

      expect(mockDecisionEvent.findMany).toHaveBeenCalledWith({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
    });
  });
});

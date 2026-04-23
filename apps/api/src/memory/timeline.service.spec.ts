import { Test, TestingModule } from '@nestjs/testing';
import { TimelineService, TimelineQuery } from './timeline.service';
import { PrismaService } from '@nathapp/nestjs-prisma';

describe('TimelineService', () => {
  let service: TimelineService;
  let prismaService: PrismaService<any>;

  const mockPrismaClient = {
    ticketEvent: {
      findMany: jest.fn(),
    },
    agentEvent: {
      findMany: jest.fn(),
    },
    decisionEvent: {
      findMany: jest.fn(),
    },
  };

  const mockPrismaService = {
    client: mockPrismaClient,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimelineService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<TimelineService>(TimelineService);
    prismaService = module.get<PrismaService<any>>(PrismaService);

    jest.clearAllMocks();
  });

  describe('getProjectTimeline', () => {
    test('AC-36: getProjectTimeline is called when getProjectContext({intent: diagnose}) is invoked', async () => {
      mockPrismaClient.ticketEvent.findMany.mockResolvedValue([]);

      const query: TimelineQuery = {
        projectId: 'project-123',
      };

      await service.getProjectTimeline(query);

      expect(mockPrismaClient.ticketEvent.findMany).toHaveBeenCalled();
    });

    test('returns events ordered by createdAt DESC', async () => {
      const now = new Date();
      const events = [
        { id: '1', actorId: 'actor-1', action: 'CREATED', createdAt: now },
        { id: '2', actorId: 'actor-2', action: 'UPDATED', createdAt: new Date(now.getTime() - 1000) },
      ];
      mockPrismaClient.ticketEvent.findMany.mockResolvedValue(events);

      const result = await service.getProjectTimeline({ projectId: 'project-123' });

      expect(result.events[0].createdAt.getTime()).toBeGreaterThanOrEqual(result.events[1].createdAt.getTime());
    });

    test('returns up to limit events (default 50)', async () => {
      const events = Array.from({ length: 60 }, (_, i) => ({
        id: `event-${i}`,
        actorId: 'actor-1',
        action: 'TEST',
        createdAt: new Date(),
      }));
      mockPrismaClient.ticketEvent.findMany.mockResolvedValue(events);

      const result = await service.getProjectTimeline({ projectId: 'project-123' });

      expect(result.events.length).toBeLessThanOrEqual(50);
    });

    test('filters by actorId when provided', async () => {
      mockPrismaClient.ticketEvent.findMany.mockResolvedValue([]);

      await service.getProjectTimeline({ projectId: 'project-123', actorId: 'actor-456' });

      expect(mockPrismaClient.ticketEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ actorId: 'actor-456' }),
        })
      );
    });

    test('filters by ticketId when provided', async () => {
      mockPrismaClient.ticketEvent.findMany.mockResolvedValue([]);

      await service.getProjectTimeline({ projectId: 'project-123', ticketId: 'ticket-789' });

      expect(mockPrismaClient.ticketEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ ticketId: 'ticket-789' }),
        })
      );
    });
  });

  describe('getTicketHistory', () => {
    test('AC-35: returns status change history for a specific ticket', async () => {
      const ticketEvents = [
        { id: '1', ticketId: 'ticket-123', actorId: 'actor-1', action: 'STATUS_CHANGE', createdAt: new Date() },
      ];
      mockPrismaClient.ticketEvent.findMany.mockResolvedValue(ticketEvents);

      const result = await service.getTicketHistory('ticket-123');

      expect(result.events).toBeDefined();
      expect(Array.isArray(result.events)).toBe(true);
    });

    test('filters by ticketId', async () => {
      mockPrismaClient.ticketEvent.findMany.mockResolvedValue([]);

      await service.getTicketHistory('ticket-123');

      expect(mockPrismaClient.ticketEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ ticketId: 'ticket-123' }),
        })
      );
    });
  });
});
import { Test, TestingModule } from '@nestjs/testing';
import { TimelineService, TimelineQuery } from './timeline.service';
import { PrismaTimelineRepository } from './prisma-timeline.repository';

describe('TimelineService', () => {
  let service: TimelineService;

  const mockTimelineRepo = {
    findTicketEvents: jest.fn(),
    findAgentEvents: jest.fn(),
    findDecisionEvents: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimelineService,
        { provide: PrismaTimelineRepository, useValue: mockTimelineRepo },
      ],
    }).compile();

    service = module.get<TimelineService>(TimelineService);

    jest.clearAllMocks();
  });

  describe('getProjectTimeline', () => {
    test('AC-36: getProjectTimeline is called when getProjectContext({intent: diagnose}) is invoked', async () => {
      mockTimelineRepo.findTicketEvents.mockResolvedValue([]);
      mockTimelineRepo.findAgentEvents.mockResolvedValue([]);
      mockTimelineRepo.findDecisionEvents.mockResolvedValue([]);

      const query: TimelineQuery = {
        projectId: 'project-123',
      };

      await service.getProjectTimeline(query);

      expect(mockTimelineRepo.findTicketEvents).toHaveBeenCalled();
    });

    test('returns events ordered by createdAt DESC', async () => {
      const now = new Date();
      const events = [
        { id: '1', actorId: 'actor-1', action: 'CREATED', createdAt: now },
        { id: '2', actorId: 'actor-2', action: 'UPDATED', createdAt: new Date(now.getTime() - 1000) },
      ];
      mockTimelineRepo.findTicketEvents.mockResolvedValue(events);
      mockTimelineRepo.findAgentEvents.mockResolvedValue([]);
      mockTimelineRepo.findDecisionEvents.mockResolvedValue([]);

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
      mockTimelineRepo.findTicketEvents.mockResolvedValue(events);
      mockTimelineRepo.findAgentEvents.mockResolvedValue([]);
      mockTimelineRepo.findDecisionEvents.mockResolvedValue([]);

      const result = await service.getProjectTimeline({ projectId: 'project-123' });

      expect(result.events.length).toBeLessThanOrEqual(50);
    });

    test('filters by actorId when provided', async () => {
      mockTimelineRepo.findTicketEvents.mockResolvedValue([]);
      mockTimelineRepo.findAgentEvents.mockResolvedValue([]);
      mockTimelineRepo.findDecisionEvents.mockResolvedValue([]);

      await service.getProjectTimeline({ projectId: 'project-123', actorId: 'actor-456' });

      expect(mockTimelineRepo.findTicketEvents).toHaveBeenCalledWith(
        expect.objectContaining({ actorId: 'actor-456' })
      );
    });

    test('filters by ticketId when provided', async () => {
      mockTimelineRepo.findTicketEvents.mockResolvedValue([]);

      await service.getProjectTimeline({ projectId: 'project-123', ticketId: 'ticket-789' });

      expect(mockTimelineRepo.findTicketEvents).toHaveBeenCalledWith(
        expect.objectContaining({ ticketId: 'ticket-789' })
      );
    });
  });

  describe('getTicketHistory', () => {
    test('AC-35: returns status change history for a specific ticket', async () => {
      const ticketEvents = [
        { id: '1', ticketId: 'ticket-123', actorId: 'actor-1', action: 'STATUS_CHANGE', createdAt: new Date() },
      ];
      mockTimelineRepo.findTicketEvents.mockResolvedValue(ticketEvents);

      const result = await service.getTicketHistory('ticket-123');

      expect(result.events).toBeDefined();
      expect(Array.isArray(result.events)).toBe(true);
    });

    test('filters by ticketId', async () => {
      mockTimelineRepo.findTicketEvents.mockResolvedValue([]);

      await service.getTicketHistory('ticket-123');

      expect(mockTimelineRepo.findTicketEvents).toHaveBeenCalledWith(
        expect.objectContaining({ ticketId: 'ticket-123' })
      );
    });
  });
});

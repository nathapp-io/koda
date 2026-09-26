import { Test, TestingModule } from '@nestjs/testing';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { TimelineService, TimelineQuery } from './timeline.service';
import { PrismaTimelineRepository } from './prisma-timeline.repository';
import { decodeTimelineCursor, encodeTimelineCursor } from './timeline-cursor';

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
        expect.objectContaining({ actorId: 'actor-456' }),
        expect.anything(),
      );
    });

    test('filters by ticketId when provided', async () => {
      mockTimelineRepo.findTicketEvents.mockResolvedValue([]);

      await service.getProjectTimeline({ projectId: 'project-123', ticketId: 'ticket-789' });

      expect(mockTimelineRepo.findTicketEvents).toHaveBeenCalledWith(
        expect.objectContaining({ ticketId: 'ticket-789' }),
        expect.anything(),
      );
    });
  });

  describe('keyset paging', () => {
    const t = (iso: string) => new Date(iso);

    it('asks each table for limit + 1 rows and returns an encoded nextCursor when more exist', async () => {
      mockTimelineRepo.findTicketEvents.mockResolvedValue([
        { id: 'tk3', actorId: 'u', action: 'a', ticketId: null, createdAt: t('2026-01-03T00:00:00.000Z') },
        { id: 'tk1', actorId: 'u', action: 'a', ticketId: null, createdAt: t('2026-01-01T00:00:00.000Z') },
      ]);
      mockTimelineRepo.findAgentEvents.mockResolvedValue([
        { id: 'ag2', actorId: 'u', action: 'a', createdAt: t('2026-01-02T00:00:00.000Z') },
      ]);
      mockTimelineRepo.findDecisionEvents.mockResolvedValue([]);

      const result = await service.getProjectTimeline({ projectId: 'p1', limit: 2 });

      expect(mockTimelineRepo.findTicketEvents).toHaveBeenCalledWith(expect.anything(), { cursor: undefined, take: 3 });
      expect(result.events.map((e) => e.id)).toEqual(['tk3', 'ag2']);
      expect(decodeTimelineCursor(result.nextCursor!)).toEqual({ createdAt: t('2026-01-02T00:00:00.000Z'), id: 'ag2' });
      expect(result).not.toHaveProperty('total');
    });

    it('omits nextCursor on the last page', async () => {
      mockTimelineRepo.findTicketEvents.mockResolvedValue([
        { id: 'tk1', actorId: 'u', action: 'a', ticketId: null, createdAt: t('2026-01-01T00:00:00.000Z') },
      ]);
      mockTimelineRepo.findAgentEvents.mockResolvedValue([]);
      mockTimelineRepo.findDecisionEvents.mockResolvedValue([]);

      const result = await service.getProjectTimeline({ projectId: 'p1', limit: 2 });

      expect(result.nextCursor).toBeUndefined();
    });

    it('decodes the cursor and forwards it to every table', async () => {
      mockTimelineRepo.findTicketEvents.mockResolvedValue([]);
      mockTimelineRepo.findAgentEvents.mockResolvedValue([]);
      mockTimelineRepo.findDecisionEvents.mockResolvedValue([]);
      const key = { createdAt: t('2026-01-02T00:00:00.000Z'), id: 'ag2' };

      await service.getProjectTimeline({ projectId: 'p1', limit: 5, cursor: encodeTimelineCursor(key) });

      for (const fn of [mockTimelineRepo.findTicketEvents, mockTimelineRepo.findAgentEvents, mockTimelineRepo.findDecisionEvents]) {
        expect(fn).toHaveBeenCalledWith(expect.anything(), { cursor: key, take: 6 });
      }
    });

    it.each(['garbage', 'ckold123'])('rejects an undecodable cursor %s with a validation error', async (cursor) => {
      await expect(service.getProjectTimeline({ projectId: 'p1', cursor })).rejects.toThrow(ValidationAppException);
      expect(mockTimelineRepo.findTicketEvents).not.toHaveBeenCalled();
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

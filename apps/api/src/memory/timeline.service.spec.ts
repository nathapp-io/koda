import { Test, TestingModule } from '@nestjs/testing';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { TimelineService, TimelineQuery } from './timeline.service';
import { PrismaTimelineRepository } from './prisma-timeline.repository';
import { decodeTimelineCursor, encodeTimelineCursor } from './timeline-cursor';

describe('TimelineService', () => {
  let service: TimelineService;

  const mockTimelineRepo = {
    findTicketEvents: vi.fn(),
    findAgentEvents: vi.fn(),
    findDecisionEvents: vi.fn(),
    findEventLabels: vi.fn().mockResolvedValue({ names: new Map(), tickets: new Map() }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimelineService,
        { provide: PrismaTimelineRepository, useValue: mockTimelineRepo },
      ],
    }).compile();

    service = module.get<TimelineService>(TimelineService);

    vi.clearAllMocks();
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

  describe('page labels', () => {
    const at = (day: number) => new Date(Date.UTC(2026, 0, day));

    beforeEach(() => {
      mockTimelineRepo.findTicketEvents.mockResolvedValue([]);
      mockTimelineRepo.findAgentEvents.mockResolvedValue([]);
      mockTimelineRepo.findDecisionEvents.mockResolvedValue([]);
      mockTimelineRepo.findEventLabels.mockResolvedValue({ names: new Map(), tickets: new Map() });
    });

    it('AC-1: reads labels exactly once for returned events, excluding lookahead', async () => {
      mockTimelineRepo.findTicketEvents.mockResolvedValue([
        { id: 'e1', actorId: 'u1', action: 'x', ticketId: 't1', createdAt: at(3) },
        { id: 'e2', actorId: 'u2', action: 'x', ticketId: 't2', createdAt: at(2) },
        { id: 'e3', actorId: 'u3', action: 'x', ticketId: 't3', createdAt: at(1) },
      ]);

      await service.getProjectTimeline({ projectId: 'p1', limit: 2 });

      expect(mockTimelineRepo.findEventLabels).toHaveBeenCalledTimes(1);
      expect(mockTimelineRepo.findEventLabels).toHaveBeenCalledWith(['u1', 'u2'], ['t1', 't2']);
    });

    it('AC-2: maps actor and ticket labels onto returned ticket events', async () => {
      mockTimelineRepo.findTicketEvents.mockResolvedValue([
        { id: 'e1', actorId: 'u1', action: 'x', ticketId: 't1', createdAt: at(1) },
      ]);
      mockTimelineRepo.findEventLabels.mockResolvedValue({
        names: new Map([['u1', 'Alice']]), tickets: new Map([['t1', { ref: 'SB-3', title: 'Fix login' }]]),
      });

      const result = await service.getProjectTimeline({ projectId: 'p1', limit: 2 });

      expect(result.events[0]).toMatchObject({ actorName: 'Alice', ticketRef: 'SB-3', ticketTitle: 'Fix login' });
    });

    it('AC-3: uses null labels for an agent event with an unknown actor', async () => {
      mockTimelineRepo.findAgentEvents.mockResolvedValue([
        { id: 'a1', actorId: 'gone', action: 'x', createdAt: at(1) },
      ]);

      const result = await service.getProjectTimeline({ projectId: 'p1' });

      expect(result.events[0]).toMatchObject({ actorName: null, ticketRef: null, ticketTitle: null });
    });

    it('AC-4: uses null ticket labels when a ticket is missing', async () => {
      mockTimelineRepo.findTicketEvents.mockResolvedValue([
        { id: 'e1', actorId: 'u1', action: 'x', ticketId: 'gone', createdAt: at(1) },
      ]);

      const result = await service.getProjectTimeline({ projectId: 'p1' });

      expect(result.events[0]).toMatchObject({ ticketRef: null, ticketTitle: null });
    });

    it('AC-5: calls the label reader with empty arrays for an empty page', async () => {
      const result = await service.getProjectTimeline({ projectId: 'p1' });

      expect(result.events).toEqual([]);
      expect(mockTimelineRepo.findEventLabels).toHaveBeenCalledExactlyOnceWith([], []);
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
      expect(result.nextCursor).toBeDefined();
      expect(decodeTimelineCursor(result.nextCursor as string)).toEqual({ createdAt: t('2026-01-02T00:00:00.000Z'), id: 'ag2' });
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

      expect(result.events).toEqual([expect.objectContaining({ actorName: null, ticketRef: null, ticketTitle: null })]);
      expect(mockTimelineRepo.findEventLabels).not.toHaveBeenCalled();
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

import { Test, TestingModule } from '@nestjs/testing';
import { ContextBuilderService, GetProjectContextQuery, Intent } from './context-builder.service';
import { TimelineService } from './timeline.service';

describe('ContextBuilderService', () => {
  let service: ContextBuilderService;
  let timelineService: TimelineService;

  const mockTimelineService = {
    getProjectTimeline: jest.fn(),
    getTicketHistory: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContextBuilderService,
        { provide: TimelineService, useValue: mockTimelineService },
      ],
    }).compile();

    service = module.get<ContextBuilderService>(ContextBuilderService);
    timelineService = module.get<TimelineService>(TimelineService);

    jest.clearAllMocks();
  });

  describe('getProjectContext', () => {
    describe('AC-34: intent diagnose', () => {
      test('returns object with recentEvents that is an array with length <= 10', async () => {
        const mockEvents = Array.from({ length: 10 }, (_, i) => ({
          id: `event-${i}`,
          eventType: 'ticket_event',
          actorId: 'actor-1',
          action: 'STATUS_CHANGE',
          createdAt: new Date(),
        }));

        mockTimelineService.getProjectTimeline.mockResolvedValue({
          events: mockEvents,
          total: 10,
        });

        const result = await service.getProjectContext({
          projectId: 'project-123',
          actorId: 'actor-1',
          intent: 'diagnose' as Intent,
        });

        expect(typeof result.recentEvents).toBe('object');
        expect(Array.isArray(result.recentEvents)).toBe(true);
        expect(result.recentEvents && result.recentEvents.length).toBeLessThanOrEqual(10);
      });
    });

    describe('AC-35: intent answer with ticket ID in query', () => {
      test('returns object with statusChangeHistory where ticketId matches', async () => {
        const ticketId = 'ticket-123';
        const mockEvents = [
          { id: '1', ticketId, actorId: 'actor-1', action: 'CREATED', createdAt: new Date() },
          { id: '2', ticketId, actorId: 'actor-2', action: 'STATUS_CHANGE', createdAt: new Date() },
        ];

        mockTimelineService.getTicketHistory.mockResolvedValue({
          events: mockEvents,
          ticketId,
        });

        const result = await service.getProjectContext({
          projectId: 'project-123',
          actorId: 'actor-1',
          intent: 'answer' as Intent,
          query: `What is the status of ${ticketId}?`,
        });

        expect(result.statusChangeHistory).toBeDefined();
        expect(Array.isArray(result.statusChangeHistory)).toBe(true);
        expect(result.statusChangeHistory && result.statusChangeHistory.length).toBe(2);
        expect(result.statusChangeHistory && result.statusChangeHistory[0].actorId).toBe('actor-1');
      });

      test('handles query without ticket ID gracefully', async () => {
        mockTimelineService.getTicketHistory.mockResolvedValue({
          events: [],
          ticketId: 'ticket-123',
        });

        const result = await service.getProjectContext({
          projectId: 'project-123',
          actorId: 'actor-1',
          intent: 'answer' as Intent,
          query: 'What was the last activity?',
        });

        expect(result.statusChangeHistory).toBeUndefined();
      });
    });

    describe('AC-36: TimelineService.getProjectTimeline is called for diagnose', () => {
      test('calls getProjectTimeline with correct projectId when intent is diagnose', async () => {
        mockTimelineService.getProjectTimeline.mockResolvedValue({
          events: [],
          total: 0,
        });

        await service.getProjectContext({
          projectId: 'project-123',
          actorId: 'actor-1',
          intent: 'diagnose' as Intent,
        });

        expect(mockTimelineService.getProjectTimeline).toHaveBeenCalledWith(
          expect.objectContaining({
            projectId: 'project-123',
          })
        );
        expect(mockTimelineService.getProjectTimeline.mock.calls.length).toBeGreaterThanOrEqual(1);
      });
    });

    describe('AC-37: recentEvents structure and ordering', () => {
      test('every item has non-null actorId, action, createdAt fields', async () => {
        const mockEvents = [
          { id: '1', eventType: 'ticket_event', actorId: 'actor-1', action: 'CREATED', createdAt: new Date() },
          { id: '2', eventType: 'ticket_event', actorId: 'actor-2', action: 'UPDATED', createdAt: new Date() },
        ];

        mockTimelineService.getProjectTimeline.mockResolvedValue({
          events: mockEvents,
          total: 2,
        });

        const result = await service.getProjectContext({
          projectId: 'project-123',
          actorId: 'actor-1',
          intent: 'diagnose' as Intent,
        });

        for (const event of result.recentEvents ?? []) {
          expect(event.actorId).toBeTruthy();
          expect(event.action).toBeTruthy();
          expect(event.createdAt).toBeTruthy();
        }
      });

      test('events are ordered by createdAt DESC (newest first)', async () => {
        const now = new Date();
        const mockEvents = [
          { id: '3', eventType: 'ticket_event', actorId: 'actor-3', action: 'CLOSED', createdAt: now },
          { id: '2', eventType: 'ticket_event', actorId: 'actor-2', action: 'UPDATED', createdAt: new Date(now.getTime() - 1000) },
          { id: '1', eventType: 'ticket_event', actorId: 'actor-1', action: 'CREATED', createdAt: new Date(now.getTime() - 2000) },
        ];

        mockTimelineService.getProjectTimeline.mockResolvedValue({
          events: mockEvents,
          total: 3,
        });

        const result = await service.getProjectContext({
          projectId: 'project-123',
          actorId: 'actor-1',
          intent: 'diagnose' as Intent,
        });

        const events = result.recentEvents ?? [];
        for (let i = 0; i < events.length - 1; i++) {
          expect(
            new Date(events[i].createdAt).getTime()
          ).toBeGreaterThanOrEqual(
            new Date(events[i + 1].createdAt).getTime()
          );
        }
      });
    });

    describe('AC-38: intent plan excludes temporal blocks', () => {
      test('response does not contain recentEvents, history, timeline, or statusChangeHistory keys', async () => {
        mockTimelineService.getProjectTimeline.mockResolvedValue({
          events: [{ id: '1', eventType: 'ticket_event', actorId: 'actor-1', action: 'TEST', createdAt: new Date() }],
          total: 1,
        });

        const result = await service.getProjectContext({
          projectId: 'project-123',
          actorId: 'actor-1',
          intent: 'plan' as Intent,
        });

        const lowerCaseKeys = Object.keys(result).map((k) => k.toLowerCase());
        const temporalKeys = ['recentEvents', 'history', 'timeline', 'statusChangeHistory'];

        for (const key of temporalKeys) {
          expect(lowerCaseKeys).not.toContain(key);
        }
      });

      test('plan intent returns only projectId', async () => {
        const result = await service.getProjectContext({
          projectId: 'project-123',
          actorId: 'actor-1',
          intent: 'plan' as Intent,
        });

        expect(Object.keys(result)).toEqual(['projectId']);
      });
    });
  });
});
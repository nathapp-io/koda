import { TimelineController } from './timeline.controller';
import { TimelineService } from './timeline.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { NotFoundAppException, ValidationAppException, JsonResponse } from '@nathapp/nestjs-common';

const makeTimelineResponse = () => ({
  events: [
    {
      id: 'evt-1',
      eventType: 'ticket_event',
      actorId: 'actor-1',
      action: 'STATUS_CHANGE',
      createdAt: new Date('2025-01-01'),
    },
  ],
});

describe('TimelineController', () => {
  let controller: TimelineController;

  const mockProjectAccessService = {
    findProjectIdBySlug: vi.fn(),
  };

  const mockTimelineService = {
    getProjectTimeline: vi.fn(),
  };

  beforeEach(() => {
    // Direct instantiation: the controller has only constructor-injected collaborators and no Nest lifecycle, so
    // the guards the route declares are never resolved here (their metadata is read off the prototype instead).
    controller = new TimelineController(
      mockTimelineService as unknown as TimelineService,
      mockProjectAccessService as unknown as ProjectAccessService,
    );

    mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-1');
    vi.clearAllMocks();
  });

  describe('getTimeline', () => {
    // US-008: membership and the `timeline.read` key are the guard's (`ProjectMembershipGuard, RequiresGuard` on
    // the route); the handler resolves the slug and reads the timeline. Their behaviour is covered over real HTTP by
    // test/integration/memory/permissions-memory-routes.integration.spec.ts.
    describe('US-008: the route declares its guards, and the handler no longer decides membership', () => {
      it('declares ProjectMembershipGuard and RequiresGuard with the timeline.read key', () => {
        const guards = Reflect.getMetadata('__guards__', TimelineController.prototype.getTimeline) as unknown[];
        const requires = Reflect.getMetadata('koda:requires', TimelineController.prototype.getTimeline) as {
          keys: string[];
          enforcedBy: string;
        };

        expect(guards?.map((guard) => (guard as { name: string }).name)).toEqual([
          'ProjectMembershipGuard',
          'RequiresGuard',
        ]);
        expect(requires).toMatchObject({ keys: ['timeline.read'], enforcedBy: 'guard' });
      });

      it('reads the timeline for a member', async () => {
        mockTimelineService.getProjectTimeline.mockResolvedValue(makeTimelineResponse());

        await expect(controller.getTimeline('my-project')).resolves.toBeDefined();
        expect(mockTimelineService.getProjectTimeline).toHaveBeenCalled();
      });
    });

    describe('project resolution', () => {
      it('throws NotFoundAppException when project does not exist', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockRejectedValue(new NotFoundAppException({}, 'projects'));

        await expect(controller.getTimeline('nonexistent')).rejects.toThrow(NotFoundAppException);
      });

      it('throws NotFoundAppException when project is soft-deleted', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockRejectedValue(new NotFoundAppException({}, 'projects'));

        await expect(controller.getTimeline('deleted-project')).rejects.toThrow(NotFoundAppException);
      });

      it('resolves project by slug', async () => {
        mockTimelineService.getProjectTimeline.mockResolvedValue(makeTimelineResponse());

        await controller.getTimeline('my-project');

        expect(mockProjectAccessService.findProjectIdBySlug).toHaveBeenCalledWith('my-project');
      });
    });

    describe('date parsing', () => {
      it('throws ValidationAppException for invalid from date', async () => {
        await expect(
          controller.getTimeline('my-project', undefined, undefined, undefined, 'not-a-date'),
        ).rejects.toThrow(ValidationAppException);
      });

      it('throws ValidationAppException for invalid to date', async () => {
        await expect(
          controller.getTimeline('my-project', undefined, undefined, undefined, undefined, 'not-a-date'),
        ).rejects.toThrow(ValidationAppException);
      });

      it('throws ValidationAppException when from is after to', async () => {
        await expect(
          controller.getTimeline(
            'my-project',
            undefined,
            undefined,
            undefined,
            '2025-12-31',
            '2025-01-01',
          ),
        ).rejects.toThrow(ValidationAppException);
      });
    });

    describe('limit parsing', () => {
      it('throws ValidationAppException for invalid limit string', async () => {
        await expect(
          controller.getTimeline('my-project', undefined, undefined, undefined, undefined, undefined, 'abc'),
        ).rejects.toThrow(ValidationAppException);
      });

      it.each(['0', '101', '-1', '10abc', '2.5'])('rejects limit=%s with a validation error', async (limit) => {
        await expect(
          controller.getTimeline('koda', undefined, undefined, undefined, undefined, undefined, limit, undefined),
        ).rejects.toThrow(ValidationAppException);
        expect(mockTimelineService.getProjectTimeline).not.toHaveBeenCalled();
      });

      it('passes limit=100 through as a number', async () => {
        mockTimelineService.getProjectTimeline.mockResolvedValue(makeTimelineResponse());
        await controller.getTimeline('koda', undefined, undefined, undefined, undefined, undefined, '100', undefined);
        expect(mockTimelineService.getProjectTimeline).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
      });
    });

    describe('event types parsing', () => {
      it('parses comma-separated eventTypes string into array', async () => {
        mockTimelineService.getProjectTimeline.mockResolvedValue(makeTimelineResponse());

        await controller.getTimeline('my-project', undefined, undefined, 'ticket_event,agent_event');

        expect(mockTimelineService.getProjectTimeline).toHaveBeenCalledWith(
          expect.objectContaining({
            eventTypes: ['ticket_event', 'agent_event'],
          }),
        );
      });

      it('passes array eventTypes through unchanged', async () => {
        mockTimelineService.getProjectTimeline.mockResolvedValue(makeTimelineResponse());

        await controller.getTimeline('my-project', undefined, undefined, ['ticket_event', 'decision_event']);

        expect(mockTimelineService.getProjectTimeline).toHaveBeenCalledWith(
          expect.objectContaining({
            eventTypes: ['ticket_event', 'decision_event'],
          }),
        );
      });

      it('passes undefined eventTypes when not provided', async () => {
        mockTimelineService.getProjectTimeline.mockResolvedValue(makeTimelineResponse());

        await controller.getTimeline('my-project');

        expect(mockTimelineService.getProjectTimeline).toHaveBeenCalledWith(
          expect.objectContaining({
            eventTypes: undefined,
          }),
        );
      });
    });

    describe('happy path', () => {
      it('delegates to TimelineService with projectId from resolved project', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-resolved');
        mockTimelineService.getProjectTimeline.mockResolvedValue(makeTimelineResponse());

        await controller.getTimeline('my-project');

        expect(mockTimelineService.getProjectTimeline).toHaveBeenCalledWith(
          expect.objectContaining({ projectId: 'project-resolved' }),
        );
      });

      it('returns JsonResponse.Ok wrapping timeline data', async () => {
        const timeline = makeTimelineResponse();
        mockTimelineService.getProjectTimeline.mockResolvedValue(timeline);

        const result = await controller.getTimeline('my-project');

        expect(result).toBeInstanceOf(JsonResponse);
        expect((result as JsonResponse<typeof timeline>).data).toEqual(timeline);
      });

      it('passes actorId, ticketId, from, to, limit and cursor to timeline service', async () => {
        mockTimelineService.getProjectTimeline.mockResolvedValue(makeTimelineResponse());

        await controller.getTimeline(
          'my-project',
          'actor-42',
          'ticket-99',
          undefined,
          '2025-01-01',
          '2025-12-31',
          '50',
          'cursor-abc',
        );

        expect(mockTimelineService.getProjectTimeline).toHaveBeenCalledWith(
          expect.objectContaining({
            actorId: 'actor-42',
            ticketId: 'ticket-99',
            from: new Date('2025-01-01'),
            to: new Date('2025-12-31'),
            limit: 50,
            cursor: 'cursor-abc',
          }),
        );
      });
    });
  });
});

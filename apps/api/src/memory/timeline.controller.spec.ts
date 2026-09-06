import { Test, TestingModule } from '@nestjs/testing';
import { TimelineController } from './timeline.controller';
import { TimelineService } from './timeline.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { ForbiddenAppException, NotFoundAppException, ValidationAppException, JsonResponse } from '@nathapp/nestjs-common';
import type { KodaPrincipal, UserPrincipal } from '../auth/principal/koda-principal.types';

const makeUserPrincipal = (role: UserPrincipal['role'] = 'MEMBER'): UserPrincipal => ({
  actorType: 'user',
  id: 'user-1',
  name: undefined,
  blacklisted: false,
  revoked: false,
  authorities: [],
  role,
  email: 'test@example.com',
});

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
  total: 1,
});

describe('TimelineController', () => {
  let controller: TimelineController;

  const mockProjectAccessService = {
    findProjectIdBySlug: jest.fn(),
    assertProjectMembership: jest.fn(),
  };

  const mockTimelineService = {
    getProjectTimeline: jest.fn(),
  };

  const memberPrincipal: KodaPrincipal = makeUserPrincipal('MEMBER');

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimelineController,
        { provide: TimelineService, useValue: mockTimelineService },
        { provide: ProjectAccessService, useValue: mockProjectAccessService },
      ],
    }).compile();

    controller = module.get<TimelineController>(TimelineController);

    mockProjectAccessService.findProjectIdBySlug.mockResolvedValue('project-1');
    mockProjectAccessService.assertProjectMembership.mockResolvedValue(undefined);
    jest.clearAllMocks();
  });

  describe('getTimeline', () => {
    describe('membership check', () => {
      it('throws ForbiddenAppException when caller is not a project member', async () => {
        mockProjectAccessService.assertProjectMembership.mockRejectedValue(new ForbiddenAppException({}, 'projects'));

        await expect(controller.getTimeline('my-project', memberPrincipal)).rejects.toThrow(ForbiddenAppException);
        expect(mockTimelineService.getProjectTimeline).not.toHaveBeenCalled();
      });

      it('passes when caller is a project member', async () => {
        mockTimelineService.getProjectTimeline.mockResolvedValue(makeTimelineResponse());

        await expect(controller.getTimeline('my-project', memberPrincipal)).resolves.toBeDefined();
        expect(mockProjectAccessService.assertProjectMembership).toHaveBeenCalledWith('project-1', memberPrincipal);
      });
    });

    describe('project resolution', () => {
      it('throws NotFoundAppException when project does not exist', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockRejectedValue(new NotFoundAppException({}, 'projects'));

        await expect(controller.getTimeline('nonexistent', memberPrincipal)).rejects.toThrow(NotFoundAppException);
      });

      it('throws NotFoundAppException when project is soft-deleted', async () => {
        mockProjectAccessService.findProjectIdBySlug.mockRejectedValue(new NotFoundAppException({}, 'projects'));

        await expect(controller.getTimeline('deleted-project', memberPrincipal)).rejects.toThrow(NotFoundAppException);
      });

      it('resolves project by slug', async () => {
        mockTimelineService.getProjectTimeline.mockResolvedValue(makeTimelineResponse());

        await controller.getTimeline('my-project', memberPrincipal);

        expect(mockProjectAccessService.findProjectIdBySlug).toHaveBeenCalledWith('my-project');
      });
    });

    describe('date parsing', () => {
      it('throws ValidationAppException for invalid from date', async () => {
        await expect(
          controller.getTimeline('my-project', memberPrincipal, undefined, undefined, undefined, 'not-a-date'),
        ).rejects.toThrow(ValidationAppException);
      });

      it('throws ValidationAppException for invalid to date', async () => {
        await expect(
          controller.getTimeline('my-project', memberPrincipal, undefined, undefined, undefined, undefined, 'not-a-date'),
        ).rejects.toThrow(ValidationAppException);
      });

      it('throws ValidationAppException when from is after to', async () => {
        await expect(
          controller.getTimeline(
            'my-project',
            memberPrincipal,
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
          controller.getTimeline('my-project', memberPrincipal, undefined, undefined, undefined, undefined, undefined, 'abc'),
        ).rejects.toThrow(ValidationAppException);
      });
    });

    describe('event types parsing', () => {
      it('parses comma-separated eventTypes string into array', async () => {
        mockTimelineService.getProjectTimeline.mockResolvedValue(makeTimelineResponse());

        await controller.getTimeline('my-project', memberPrincipal, undefined, undefined, 'ticket_event,agent_event');

        expect(mockTimelineService.getProjectTimeline).toHaveBeenCalledWith(
          expect.objectContaining({
            eventTypes: ['ticket_event', 'agent_event'],
          }),
        );
      });

      it('passes array eventTypes through unchanged', async () => {
        mockTimelineService.getProjectTimeline.mockResolvedValue(makeTimelineResponse());

        await controller.getTimeline('my-project', memberPrincipal, undefined, undefined, ['ticket_event', 'decision_event']);

        expect(mockTimelineService.getProjectTimeline).toHaveBeenCalledWith(
          expect.objectContaining({
            eventTypes: ['ticket_event', 'decision_event'],
          }),
        );
      });

      it('passes undefined eventTypes when not provided', async () => {
        mockTimelineService.getProjectTimeline.mockResolvedValue(makeTimelineResponse());

        await controller.getTimeline('my-project', memberPrincipal);

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

        await controller.getTimeline('my-project', memberPrincipal);

        expect(mockTimelineService.getProjectTimeline).toHaveBeenCalledWith(
          expect.objectContaining({ projectId: 'project-resolved' }),
        );
      });

      it('returns JsonResponse.Ok wrapping timeline data', async () => {
        const timeline = makeTimelineResponse();
        mockTimelineService.getProjectTimeline.mockResolvedValue(timeline);

        const result = await controller.getTimeline('my-project', memberPrincipal);

        expect(result).toBeInstanceOf(JsonResponse);
        expect((result as JsonResponse<typeof timeline>).data).toEqual(timeline);
      });

      it('passes actorId, ticketId, from, to, limit and cursor to timeline service', async () => {
        mockTimelineService.getProjectTimeline.mockResolvedValue(makeTimelineResponse());

        await controller.getTimeline(
          'my-project',
          memberPrincipal,
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

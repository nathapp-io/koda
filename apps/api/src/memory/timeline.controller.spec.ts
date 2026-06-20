import { Test, TestingModule } from '@nestjs/testing';
import { TimelineController } from './timeline.controller';
import { TimelineService } from './timeline.service';
import { PrismaProjectRepository } from '../projects/prisma-project.repository';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { JsonResponse } from '@nathapp/nestjs-common';

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

  const mockProjectRepo = {
    findBySlug: jest.fn(),
  };

  const mockTimelineService = {
    getProjectTimeline: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimelineController,
        { provide: TimelineService, useValue: mockTimelineService },
        { provide: PrismaProjectRepository, useValue: mockProjectRepo },
      ],
    }).compile();

    controller = module.get<TimelineController>(TimelineController);

    jest.clearAllMocks();
  });

  describe('getTimeline', () => {
    describe('project resolution', () => {
      it('throws NotFoundAppException when project does not exist', async () => {
        mockProjectRepo.findBySlug.mockResolvedValue(null);

        await expect(controller.getTimeline('nonexistent')).rejects.toThrow(NotFoundAppException);
      });

      it('throws NotFoundAppException when project is soft-deleted', async () => {
        mockProjectRepo.findBySlug.mockResolvedValue({ id: 'p-1', deletedAt: new Date() });

        await expect(controller.getTimeline('deleted-project')).rejects.toThrow(NotFoundAppException);
      });

      it('resolves project by slug', async () => {
        mockProjectRepo.findBySlug.mockResolvedValue({ id: 'project-1', deletedAt: null });
        mockTimelineService.getProjectTimeline.mockResolvedValue(makeTimelineResponse());

        await controller.getTimeline('my-project');

        expect(mockProjectRepo.findBySlug).toHaveBeenCalledWith('my-project');
      });
    });

    describe('date parsing', () => {
      it('throws ValidationAppException for invalid from date', async () => {
        mockProjectRepo.findBySlug.mockResolvedValue({ id: 'project-1', deletedAt: null });

        await expect(
          controller.getTimeline('my-project', undefined, undefined, undefined, 'not-a-date'),
        ).rejects.toThrow(ValidationAppException);
      });

      it('throws ValidationAppException for invalid to date', async () => {
        mockProjectRepo.findBySlug.mockResolvedValue({ id: 'project-1', deletedAt: null });

        await expect(
          controller.getTimeline('my-project', undefined, undefined, undefined, undefined, 'not-a-date'),
        ).rejects.toThrow(ValidationAppException);
      });

      it('throws ValidationAppException when from is after to', async () => {
        mockProjectRepo.findBySlug.mockResolvedValue({ id: 'project-1', deletedAt: null });

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
        mockProjectRepo.findBySlug.mockResolvedValue({ id: 'project-1', deletedAt: null });

        await expect(
          controller.getTimeline('my-project', undefined, undefined, undefined, undefined, undefined, 'abc'),
        ).rejects.toThrow(ValidationAppException);
      });
    });

    describe('event types parsing', () => {
      it('parses comma-separated eventTypes string into array', async () => {
        mockProjectRepo.findBySlug.mockResolvedValue({ id: 'project-1', deletedAt: null });
        mockTimelineService.getProjectTimeline.mockResolvedValue(makeTimelineResponse());

        await controller.getTimeline('my-project', undefined, undefined, 'ticket_event,agent_event');

        expect(mockTimelineService.getProjectTimeline).toHaveBeenCalledWith(
          expect.objectContaining({
            eventTypes: ['ticket_event', 'agent_event'],
          }),
        );
      });

      it('passes array eventTypes through unchanged', async () => {
        mockProjectRepo.findBySlug.mockResolvedValue({ id: 'project-1', deletedAt: null });
        mockTimelineService.getProjectTimeline.mockResolvedValue(makeTimelineResponse());

        await controller.getTimeline('my-project', undefined, undefined, ['ticket_event', 'decision_event']);

        expect(mockTimelineService.getProjectTimeline).toHaveBeenCalledWith(
          expect.objectContaining({
            eventTypes: ['ticket_event', 'decision_event'],
          }),
        );
      });

      it('passes undefined eventTypes when not provided', async () => {
        mockProjectRepo.findBySlug.mockResolvedValue({ id: 'project-1', deletedAt: null });
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
        mockProjectRepo.findBySlug.mockResolvedValue({ id: 'project-resolved', deletedAt: null });
        mockTimelineService.getProjectTimeline.mockResolvedValue(makeTimelineResponse());

        await controller.getTimeline('my-project');

        expect(mockTimelineService.getProjectTimeline).toHaveBeenCalledWith(
          expect.objectContaining({ projectId: 'project-resolved' }),
        );
      });

      it('returns JsonResponse.Ok wrapping timeline data', async () => {
        mockProjectRepo.findBySlug.mockResolvedValue({ id: 'project-1', deletedAt: null });
        const timeline = makeTimelineResponse();
        mockTimelineService.getProjectTimeline.mockResolvedValue(timeline);

        const result = await controller.getTimeline('my-project');

        expect(result).toBeInstanceOf(JsonResponse);
        expect((result as JsonResponse<typeof timeline>).data).toEqual(timeline);
      });

      it('passes actorId, ticketId, from, to, limit and cursor to timeline service', async () => {
        mockProjectRepo.findBySlug.mockResolvedValue({ id: 'project-1', deletedAt: null });
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

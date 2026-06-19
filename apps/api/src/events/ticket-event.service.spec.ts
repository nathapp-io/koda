import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { TicketEventService } from './ticket-event.service';
import { PrismaEventsRepository } from './prisma-events.repository';
import type { WriteTicketEventInput } from '../koda-domain-writer/write-result.dto';
import type { TicketEventDomain } from './domain/events.domain';

function createMockEventsRepo() {
  return {
    findProject: jest.fn(),
    createAgentEvent: jest.fn(),
    createTicketEvent: jest.fn(),
    createDecisionEvent: jest.fn(),
  };
}

describe('TicketEventService', () => {
  let service: TicketEventService;
  let mockRepo: ReturnType<typeof createMockEventsRepo>;

  const validInput: WriteTicketEventInput = {
    ticketId: 'ticket-1',
    projectId: 'project-1',
    action: 'CREATED',
    actorId: 'actor-1',
    actorType: 'user',
    source: 'api',
    data: { title: 'Fix bug' },
  };

  const ticketEventResult: TicketEventDomain = {
    id: 'event-1',
    ticketId: 'ticket-1',
    projectId: 'project-1',
    action: 'CREATED',
    actorId: 'actor-1',
    actorType: 'user',
    source: 'api',
    data: '{"title":"Fix bug"}',
    timestamp: new Date('2024-01-01'),
  };

  beforeEach(async () => {
    mockRepo = createMockEventsRepo();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketEventService,
        { provide: PrismaEventsRepository, useValue: mockRepo },
      ],
    }).compile();

    service = module.get<TicketEventService>(TicketEventService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('returns the created ticket event when project exists', async () => {
      mockRepo.findProject.mockResolvedValue({ id: 'project-1' });
      mockRepo.createTicketEvent.mockResolvedValue(ticketEventResult);

      const result = await service.create(validInput);

      expect(result).toEqual(ticketEventResult);
      expect(mockRepo.findProject).toHaveBeenCalledWith('project-1');
      expect(mockRepo.createTicketEvent).toHaveBeenCalledWith(validInput);
    });

    it('throws ForbiddenAppException when project is not found', async () => {
      mockRepo.findProject.mockResolvedValue(null);

      await expect(service.create(validInput)).rejects.toThrow(ForbiddenAppException);
      expect(mockRepo.createTicketEvent).not.toHaveBeenCalled();
    });

    it('does not call createTicketEvent when project lookup returns null', async () => {
      mockRepo.findProject.mockResolvedValue(null);

      await expect(service.create(validInput)).rejects.toThrow();

      expect(mockRepo.createTicketEvent).not.toHaveBeenCalled();
    });

    it('propagates the ForbiddenAppException with PROJECT_NOT_FOUND code', async () => {
      mockRepo.findProject.mockResolvedValue(null);

      let thrown: unknown;
      try {
        await service.create(validInput);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(ForbiddenAppException);
    });

    it('passes the full input to createTicketEvent', async () => {
      mockRepo.findProject.mockResolvedValue({ id: 'project-1' });
      mockRepo.createTicketEvent.mockResolvedValue(ticketEventResult);

      await service.create(validInput);

      expect(mockRepo.createTicketEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketId: 'ticket-1',
          projectId: 'project-1',
          action: 'CREATED',
          actorId: 'actor-1',
          actorType: 'user',
          source: 'api',
          data: { title: 'Fix bug' },
        }),
      );
    });

    it('works with agent actorType', async () => {
      const agentActorInput: WriteTicketEventInput = {
        ...validInput,
        actorType: 'agent',
      };

      const agentActorResult: TicketEventDomain = {
        ...ticketEventResult,
        actorType: 'agent',
      };

      mockRepo.findProject.mockResolvedValue({ id: 'project-1' });
      mockRepo.createTicketEvent.mockResolvedValue(agentActorResult);

      const result = await service.create(agentActorInput);

      expect(result.actorType).toBe('agent');
    });
  });
});

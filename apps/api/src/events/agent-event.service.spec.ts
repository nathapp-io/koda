import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { AgentEventService } from './agent-event.service';
import { PrismaEventsRepository } from './prisma-events.repository';
import type { WriteAgentActionInput } from '../koda-domain-writer/write-result.dto';
import type { AgentEventDomain } from './domain/events.domain';

function createMockEventsRepo() {
  return {
    findProject: jest.fn(),
    createAgentEvent: jest.fn(),
    createTicketEvent: jest.fn(),
    createDecisionEvent: jest.fn(),
  };
}

describe('AgentEventService', () => {
  let service: AgentEventService;
  let mockRepo: ReturnType<typeof createMockEventsRepo>;

  const validInput: WriteAgentActionInput = {
    agentId: 'agent-1',
    projectId: 'project-1',
    action: 'STARTED',
    actorId: 'actor-1',
    source: 'api',
    data: { key: 'value' },
  };

  const agentEventResult: AgentEventDomain = {
    id: 'event-1',
    projectId: 'project-1',
    agentId: 'agent-1',
    action: 'STARTED',
    actorId: 'actor-1',
    source: 'api',
    data: '{"key":"value"}',
    timestamp: new Date('2024-01-01'),
  };

  beforeEach(async () => {
    mockRepo = createMockEventsRepo();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentEventService,
        { provide: PrismaEventsRepository, useValue: mockRepo },
      ],
    }).compile();

    service = module.get<AgentEventService>(AgentEventService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('returns the created agent event when project exists', async () => {
      mockRepo.findProject.mockResolvedValue({ id: 'project-1' });
      mockRepo.createAgentEvent.mockResolvedValue(agentEventResult);

      const result = await service.create(validInput);

      expect(result).toEqual(agentEventResult);
      expect(mockRepo.findProject).toHaveBeenCalledWith('project-1');
      expect(mockRepo.createAgentEvent).toHaveBeenCalledWith(validInput);
    });

    it('throws ForbiddenAppException when project is not found', async () => {
      mockRepo.findProject.mockResolvedValue(null);

      await expect(service.create(validInput)).rejects.toThrow(ForbiddenAppException);
      expect(mockRepo.createAgentEvent).not.toHaveBeenCalled();
    });

    it('does not call createAgentEvent when project lookup returns null', async () => {
      mockRepo.findProject.mockResolvedValue(null);

      await expect(service.create(validInput)).rejects.toThrow();

      expect(mockRepo.createAgentEvent).not.toHaveBeenCalled();
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

    it('passes the full input to createAgentEvent', async () => {
      mockRepo.findProject.mockResolvedValue({ id: 'project-1' });
      mockRepo.createAgentEvent.mockResolvedValue(agentEventResult);

      await service.create(validInput);

      expect(mockRepo.createAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-1',
          projectId: 'project-1',
          action: 'STARTED',
          actorId: 'actor-1',
          source: 'api',
          data: { key: 'value' },
        }),
      );
    });
  });
});

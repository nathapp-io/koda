import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { DecisionEventService } from './decision-event.service';
import type { CreateDecisionEventInput } from './decision-event.service';
import { PrismaEventsRepository } from './prisma-events.repository';
import type { DecisionEventDomain } from './domain/events.domain';

function createMockEventsRepo() {
  return {
    findProject: jest.fn(),
    createAgentEvent: jest.fn(),
    createTicketEvent: jest.fn(),
    createDecisionEvent: jest.fn(),
  };
}

describe('DecisionEventService', () => {
  let service: DecisionEventService;
  let mockRepo: ReturnType<typeof createMockEventsRepo>;

  const validInput: CreateDecisionEventInput = {
    projectId: 'project-1',
    agentId: 'agent-1',
    action: 'REVIEW',
    decision: 'approved',
    rationale: 'Looks good',
    source: 'api',
    data: { ticketId: 'ticket-1' },
  };

  const decisionEventResult: DecisionEventDomain = {
    id: 'event-1',
    projectId: 'project-1',
    agentId: 'agent-1',
    action: 'REVIEW',
    decision: 'approved',
    rationale: 'Looks good',
    source: 'api',
    data: '{"ticketId":"ticket-1"}',
    timestamp: new Date('2024-01-01'),
  };

  beforeEach(async () => {
    mockRepo = createMockEventsRepo();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DecisionEventService,
        { provide: PrismaEventsRepository, useValue: mockRepo },
      ],
    }).compile();

    service = module.get<DecisionEventService>(DecisionEventService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('returns the created decision event when project exists', async () => {
      mockRepo.findProject.mockResolvedValue({ id: 'project-1' });
      mockRepo.createDecisionEvent.mockResolvedValue(decisionEventResult);

      const result = await service.create(validInput);

      expect(result).toEqual(decisionEventResult);
      expect(mockRepo.findProject).toHaveBeenCalledWith('project-1');
      expect(mockRepo.createDecisionEvent).toHaveBeenCalledWith(validInput);
    });

    it('throws ForbiddenAppException when project is not found', async () => {
      mockRepo.findProject.mockResolvedValue(null);

      await expect(service.create(validInput)).rejects.toThrow(ForbiddenAppException);
      expect(mockRepo.createDecisionEvent).not.toHaveBeenCalled();
    });

    it('does not call createDecisionEvent when project lookup returns null', async () => {
      mockRepo.findProject.mockResolvedValue(null);

      await expect(service.create(validInput)).rejects.toThrow();

      expect(mockRepo.createDecisionEvent).not.toHaveBeenCalled();
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

    it('passes the full input to createDecisionEvent', async () => {
      mockRepo.findProject.mockResolvedValue({ id: 'project-1' });
      mockRepo.createDecisionEvent.mockResolvedValue(decisionEventResult);

      await service.create(validInput);

      expect(mockRepo.createDecisionEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-1',
          agentId: 'agent-1',
          action: 'REVIEW',
          decision: 'approved',
          rationale: 'Looks good',
          source: 'api',
          data: { ticketId: 'ticket-1' },
        }),
      );
    });

    it('works with rejected decision', async () => {
      const rejectedInput: CreateDecisionEventInput = {
        ...validInput,
        decision: 'rejected',
        rationale: 'Does not meet standards',
      };

      const rejectedResult: DecisionEventDomain = {
        ...decisionEventResult,
        decision: 'rejected',
        rationale: 'Does not meet standards',
      };

      mockRepo.findProject.mockResolvedValue({ id: 'project-1' });
      mockRepo.createDecisionEvent.mockResolvedValue(rejectedResult);

      const result = await service.create(rejectedInput);

      expect(result.decision).toBe('rejected');
    });

    it('works with escalated decision', async () => {
      const escalatedInput: CreateDecisionEventInput = {
        ...validInput,
        decision: 'escalated',
        rationale: null,
      };

      const escalatedResult: DecisionEventDomain = {
        ...decisionEventResult,
        decision: 'escalated',
        rationale: null,
      };

      mockRepo.findProject.mockResolvedValue({ id: 'project-1' });
      mockRepo.createDecisionEvent.mockResolvedValue(escalatedResult);

      const result = await service.create(escalatedInput);

      expect(result.decision).toBe('escalated');
      expect(result.rationale).toBeNull();
    });

    it('works with null rationale', async () => {
      const nullRationaleInput: CreateDecisionEventInput = {
        ...validInput,
        rationale: null,
      };

      const nullRationaleResult: DecisionEventDomain = {
        ...decisionEventResult,
        rationale: null,
      };

      mockRepo.findProject.mockResolvedValue({ id: 'project-1' });
      mockRepo.createDecisionEvent.mockResolvedValue(nullRationaleResult);

      const result = await service.create(nullRationaleInput);

      expect(result.rationale).toBeNull();
    });
  });
});

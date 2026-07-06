import { Test, TestingModule } from '@nestjs/testing';
import { OutboxService } from './outbox.service';
import { OutboxFanOutRegistry } from './outbox-fan-out-registry';
import { PrismaOutboxRepository } from './prisma-outbox.repository';

function createMockFanOutRegistry() {
  return {
    dispatch: jest.fn().mockResolvedValue(undefined),
    register: jest.fn(),
    getHandlers: jest.fn().mockReturnValue([]),
  };
}

function createMockOutboxRepo() {
  return {
    enqueue: jest.fn(),
    findPending: jest.fn(),
    findByStatus: jest.fn(),
    claimForProcessing: jest.fn(),
    markCompleted: jest.fn(),
    markFailed: jest.fn(),
    markDeadLetter: jest.fn(),
    retryEvent: jest.fn(),
    incrementAttemptsAndRequeue: jest.fn(),
    requeueStaleProcessing: jest.fn(),
  };
}

describe('OutboxService', () => {
  let service: OutboxService;
  let mockRepo: ReturnType<typeof createMockOutboxRepo>;

  beforeEach(async () => {
    mockRepo = createMockOutboxRepo();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxService,
        {
          provide: PrismaOutboxRepository,
          useValue: mockRepo,
        },
        {
          provide: OutboxFanOutRegistry,
          useValue: createMockFanOutRegistry(),
        },
      ],
    }).compile();

    service = module.get<OutboxService>(OutboxService);
  });

  describe('enqueue', () => {
    it('should persist an outbox event with status pending', async () => {
      const event = {
        projectId: 'proj-123',
        eventType: 'ticket_event',
        eventId: 'ticket-event-123',
        payload: { title: 'Test Ticket' },
      };

      const created = {
        id: 'outbox-1',
        projectId: event.projectId,
        eventType: event.eventType,
        eventId: event.eventId,
        payload: JSON.stringify(event.payload),
        status: 'pending',
        attempts: 0,
        lastError: null,
        processedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockRepo.enqueue.mockResolvedValue(created);

      const result = await service.enqueue(event);

      expect(result).toEqual(expect.objectContaining({
        id: 'outbox-1',
        status: 'pending',
      }));

      expect(mockRepo.enqueue).toHaveBeenCalledWith(event);
    });

    it('should return the created outbox event', async () => {
      const event = {
        projectId: 'proj-123',
        eventType: 'agent_event',
        eventId: 'agent-event-456',
        payload: { status: 'ACTIVE' },
      };

      const createdEvent = {
        id: 'outbox-2',
        projectId: event.projectId,
        eventType: event.eventType,
        eventId: event.eventId,
        payload: JSON.stringify(event.payload),
        status: 'pending',
        attempts: 0,
        lastError: null,
        processedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockRepo.enqueue.mockResolvedValue(createdEvent);

      const result = await service.enqueue(event);

      expect(result.id).toBe('outbox-2');
      expect(result.status).toBe('pending');
    });
  });

  describe('processPending', () => {
    it('should select all pending records', async () => {
      const pendingEvents = [
        {
          id: 'outbox-1',
          projectId: 'proj-123',
          eventType: 'ticket_event',
          eventId: 'event-1',
          payload: '{}',
          status: 'pending',
          attempts: 0,
          lastError: null,
          processedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'outbox-2',
          projectId: 'proj-123',
          eventType: 'ticket_event',
          eventId: 'event-2',
          payload: '{}',
          status: 'pending',
          attempts: 1,
          lastError: null,
          processedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockRepo.requeueStaleProcessing.mockResolvedValue(undefined);
      mockRepo.findPending.mockResolvedValue(pendingEvents);
      mockRepo.claimForProcessing.mockResolvedValue(1);
      mockRepo.markCompleted.mockResolvedValue(undefined);

      await service.processPending();

      expect(mockRepo.findPending).toHaveBeenCalledWith(50);
      expect(mockRepo.requeueStaleProcessing).toHaveBeenCalledWith(expect.any(Date));
    });

    it('should claim and mark processed records as completed', async () => {
      const pendingEvents = [
        {
          id: 'outbox-1',
          projectId: 'proj-123',
          eventType: 'ticket_event',
          eventId: 'event-1',
          payload: '{}',
          status: 'pending',
          attempts: 0,
          lastError: null,
          processedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockRepo.requeueStaleProcessing.mockResolvedValue(undefined);
      mockRepo.findPending.mockResolvedValue(pendingEvents);
      mockRepo.claimForProcessing.mockResolvedValue(1);
      mockRepo.markCompleted.mockResolvedValue(undefined);

      await service.processPending();

      expect(mockRepo.claimForProcessing).toHaveBeenCalledWith('outbox-1');
      expect(mockRepo.markCompleted).toHaveBeenCalledWith('outbox-1');
    });

    it('should increment attempts and return failed records to pending', async () => {
      const pendingEvents = [
        {
          id: 'outbox-1',
          projectId: 'proj-123',
          eventType: 'ticket_event',
          eventId: 'event-1',
          payload: '{}',
          status: 'pending',
          attempts: 0,
          lastError: null,
          processedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockRepo.requeueStaleProcessing.mockResolvedValue(undefined);
      mockRepo.findPending.mockResolvedValue(pendingEvents);
      mockRepo.claimForProcessing.mockResolvedValue(1);
      mockRepo.markFailed.mockResolvedValue(undefined);

      const processEventSpy = jest
        .spyOn(service as unknown as { processEvent: (event: unknown) => Promise<void> }, 'processEvent')
        .mockRejectedValue(new Error('boom'));

      await service.processPending();

      processEventSpy.mockRestore();

      expect(mockRepo.markFailed).toHaveBeenCalledWith(
        'outbox-1',
        'boom',
        1,
        'pending',
      );
    });
  });

  describe('retry logic', () => {
    beforeEach(async () => {
      jest.spyOn(service as any, 'delay').mockResolvedValue(undefined);
    });

    it('should retry failed events up to 3 times', async () => {
      const event = {
        id: 'outbox-1',
        projectId: 'proj-123',
        eventType: 'ticket_event',
        eventId: 'event-1',
        payload: '{}',
        status: 'failed',
        attempts: 0,
        lastError: null,
        nextAttemptAt: null,
        processedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockRepo.incrementAttemptsAndRequeue.mockResolvedValue({
        ...event,
        attempts: 1,
        status: 'pending',
      });

      const retry1 = await service.retry(event);
      expect(retry1.attempts).toBe(1);

      mockRepo.incrementAttemptsAndRequeue.mockResolvedValue({
        ...event,
        attempts: 2,
        status: 'pending',
      });

      const retry2 = await service.retry({ ...event, attempts: 1 });
      expect(retry2.attempts).toBe(2);

      mockRepo.incrementAttemptsAndRequeue.mockResolvedValue({
        ...event,
        attempts: 3,
        status: 'pending',
      });

      const retry3 = await service.retry({ ...event, attempts: 2 });
      expect(retry3.attempts).toBe(3);
    });

    it('should move to dead_letter after 3 failed retries', async () => {
      const event = {
        id: 'outbox-1',
        projectId: 'proj-123',
        eventType: 'ticket_event',
        eventId: 'event-1',
        payload: '{}',
        status: 'failed',
        attempts: 3,
        lastError: null,
        nextAttemptAt: null,
        processedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockRepo.markDeadLetter.mockResolvedValue({
        ...event,
        status: 'dead_letter',
        lastError: 'Failed after 3 retries',
      });

      const result = await service.retry(event);

      expect(result.status).toBe('dead_letter');
      expect(mockRepo.markDeadLetter).toHaveBeenCalledWith(
        event.id,
        expect.any(String),
      );
    });
  });
});

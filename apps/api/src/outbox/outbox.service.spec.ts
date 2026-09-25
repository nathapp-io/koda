import { Test, TestingModule } from '@nestjs/testing';
import { OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';
import { OutboxService } from './outbox.service';
import { PrismaOutboxRepository } from './prisma-outbox.repository';

function createMockNathappOutbox() {
  return {
    record: jest.fn().mockResolvedValue({ id: 'record-1' }),
  };
}

function createMockOutboxRepo() {
  return {
    findByStatus: jest.fn().mockResolvedValue([]),
    resetForRetry: jest.fn().mockResolvedValue(1),
    recordLastError: jest.fn(),
  };
}

describe('OutboxService (transitional adapter)', () => {
  let service: OutboxService;
  let mockOutbox: ReturnType<typeof createMockNathappOutbox>;
  let mockRepo: ReturnType<typeof createMockOutboxRepo>;

  beforeEach(async () => {
    mockOutbox = createMockNathappOutbox();
    mockRepo = createMockOutboxRepo();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxService,
        { provide: NathappOutboxService, useValue: mockOutbox },
        { provide: PrismaOutboxRepository, useValue: mockRepo },
      ],
    }).compile();

    service = module.get<OutboxService>(OutboxService);
  });

  describe('enqueue', () => {
    it('records through the package with type, payload and projectId/eventId metadata', async () => {
      const event = {
        projectId: 'proj-123',
        eventType: 'ticket_event',
        eventId: 'ticket-event-123',
        payload: { title: 'Test Ticket' },
      };

      await service.enqueue(event);

      expect(mockOutbox.record).toHaveBeenCalledWith({
        type: 'ticket_event',
        payload: { title: 'Test Ticket' },
        metadata: { projectId: 'proj-123', eventId: 'ticket-event-123' },
      });
    });
  });

  describe('getPendingEvents', () => {
    it('delegates to findByStatus("pending") with the requested limit', async () => {
      await service.getPendingEvents(7);

      expect(mockRepo.findByStatus).toHaveBeenCalledWith('pending', 7);
    });

    it('defaults to limit 100 and clamps negatives to 0', async () => {
      await service.getPendingEvents();
      expect(mockRepo.findByStatus).toHaveBeenLastCalledWith('pending', 100);

      await service.getPendingEvents(-5);
      expect(mockRepo.findByStatus).toHaveBeenLastCalledWith('pending', 0);
    });
  });

  describe('getEventsByStatus', () => {
    it('delegates to findByStatus with the clamped limit', async () => {
      await service.getEventsByStatus('dead', 2.9);

      expect(mockRepo.findByStatus).toHaveBeenCalledWith('dead', 2);
    });
  });

  describe('retryEvent', () => {
    it('resets the row for retry, due now', async () => {
      await service.retryEvent('outbox-1');

      expect(mockRepo.resetForRetry).toHaveBeenCalledWith('outbox-1', expect.any(Date));
    });
  });
});

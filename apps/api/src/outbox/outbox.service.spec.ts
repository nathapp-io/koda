import { Test, TestingModule } from '@nestjs/testing';
import { OutboxService } from './outbox.service';
import { OutboxFanOutRegistry } from './outbox-fan-out-registry';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';

function createMockFanOutRegistry() {
  return {
    dispatch: jest.fn().mockResolvedValue(undefined),
    register: jest.fn(),
    getHandlers: jest.fn().mockReturnValue([]),
  };
}

describe('OutboxService', () => {
  let service: OutboxService;
  let mockPrisma: any;

  beforeEach(async () => {
    mockPrisma = {
      client: {
        outboxEvent: {
          create: jest.fn(),
          findMany: jest.fn(),
          updateMany: jest.fn(),
          update: jest.fn(),
        },
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxService,
        {
          provide: PrismaService,
          useValue: mockPrisma,
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

      mockPrisma.client.outboxEvent.create.mockResolvedValue({
        id: 'outbox-1',
        ...event,
        status: 'pending',
        attempts: 0,
        lastError: null,
        processedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.enqueue(event);

      expect(result).toEqual(expect.objectContaining({
        id: 'outbox-1',
        status: 'pending',
      }));

      expect(mockPrisma.client.outboxEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          projectId: event.projectId,
          eventType: event.eventType,
          eventId: event.eventId,
          payload: JSON.stringify(event.payload),
          status: 'pending',
        }),
      });
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
        ...event,
        payload: JSON.stringify(event.payload),
        status: 'pending',
        attempts: 0,
        lastError: null,
        processedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.client.outboxEvent.create.mockResolvedValue(createdEvent);

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

      mockPrisma.client.outboxEvent.findMany.mockResolvedValue(pendingEvents);
      mockPrisma.client.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.client.outboxEvent.update.mockResolvedValue({ status: 'completed' });

      await service.processPending();

      expect(mockPrisma.client.outboxEvent.findMany).toHaveBeenCalledWith({
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' },
        take: 50,
      });
      expect(mockPrisma.client.outboxEvent.updateMany).toHaveBeenNthCalledWith(1, {
        where: {
          status: 'processing',
          updatedAt: { lt: expect.any(Date) },
        },
        data: { status: 'pending' },
      });
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

      mockPrisma.client.outboxEvent.findMany.mockResolvedValue(pendingEvents);
      mockPrisma.client.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.client.outboxEvent.update.mockResolvedValue({
        id: 'outbox-1',
        status: 'completed',
        processedAt: expect.any(Date),
      });

      await service.processPending();

      expect(mockPrisma.client.outboxEvent.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: 'outbox-1', status: 'pending' },
        data: { status: 'processing' },
      });

      expect(mockPrisma.client.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: 'outbox-1' },
        data: {
          status: 'completed',
          processedAt: expect.any(Date),
          lastError: null,
        },
      });
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

      mockPrisma.client.outboxEvent.findMany.mockResolvedValue(pendingEvents);
      mockPrisma.client.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.client.outboxEvent.update.mockResolvedValue({ attempts: 1, status: 'pending' });

      const processEventSpy = jest
        .spyOn(service as unknown as { processEvent: (event: unknown) => Promise<void> }, 'processEvent')
        .mockRejectedValue(new Error('boom'));

      await service.processPending();

      processEventSpy.mockRestore();

      expect(mockPrisma.client.outboxEvent.update).toHaveBeenNthCalledWith(1, {
        where: { id: 'outbox-1' },
        data: {
          attempts: 1,
          lastError: 'boom',
          status: 'pending',
        },
      });
    });
  });

  describe('retry logic', () => {
    beforeEach(async () => {
      // Mock the private delay method to be instant (avoids 1s+4s+16s wait)
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
        processedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.client.outboxEvent.update.mockResolvedValue({
        ...event,
        attempts: 1,
        lastError: null,
        processedAt: null,
        createdAt: event.createdAt,
        updatedAt: new Date(),
      });

      // First retry
      const retry1 = await service.retry(event);
      expect(retry1.attempts).toBe(1);

      // Update mock for second retry
      mockPrisma.client.outboxEvent.update.mockResolvedValue({
        ...event,
        attempts: 2,
        lastError: null,
        processedAt: null,
        createdAt: event.createdAt,
        updatedAt: new Date(),
      });

      // Second retry
      const retry2 = await service.retry({ ...event, attempts: 1 });
      expect(retry2.attempts).toBe(2);

      // Update mock for third retry
      mockPrisma.client.outboxEvent.update.mockResolvedValue({
        ...event,
        attempts: 3,
        lastError: null,
        processedAt: null,
        createdAt: event.createdAt,
        updatedAt: new Date(),
      });

      // Third retry
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
        processedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.client.outboxEvent.update.mockResolvedValue({
        ...event,
        status: 'dead_letter',
        lastError: `Failed after 3 retries`,
        processedAt: null,
        createdAt: event.createdAt,
        updatedAt: new Date(),
      });

      const result = await service.retry(event);

      expect(result.status).toBe('dead_letter');
      expect(mockPrisma.client.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: event.id },
        data: {
          status: 'dead_letter',
          lastError: expect.any(String),
        },
      });
    });
  });
});

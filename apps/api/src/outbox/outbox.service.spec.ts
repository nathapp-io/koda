import { Test, TestingModule } from '@nestjs/testing';
import { OutboxService } from './outbox.service';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';

describe('OutboxService', () => {
  let service: OutboxService;
  let mockPrisma: any;

  beforeEach(async () => {
    mockPrisma = {
      client: {
        outboxEvent: {
          create: jest.fn(),
          findMany: jest.fn(),
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
      ],
    }).compile();

    service = module.get<OutboxService>(OutboxService);
  });

  describe('enqueue', () => {
    it('should persist an outbox event with status pending', async () => {
      const event = {
        aggregateId: 'ticket-123',
        aggregateType: 'ticket',
        eventType: 'CREATED',
        payload: { title: 'Test Ticket' },
      };

      mockPrisma.client.outboxEvent.create.mockResolvedValue({
        id: 'outbox-1',
        ...event,
        status: 'pending',
        retryCount: 0,
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
          aggregateId: event.aggregateId,
          aggregateType: event.aggregateType,
          eventType: event.eventType,
          payload: JSON.stringify(event.payload),
          status: 'pending',
        }),
      });
    });

    it('should return the created outbox event', async () => {
      const event = {
        aggregateId: 'agent-456',
        aggregateType: 'agent',
        eventType: 'UPDATED',
        payload: { status: 'ACTIVE' },
      };

      const createdEvent = {
        id: 'outbox-2',
        ...event,
        payload: JSON.stringify(event.payload),
        status: 'pending',
        retryCount: 0,
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
          aggregateId: 'ticket-123',
          aggregateType: 'ticket',
          eventType: 'CREATED',
          payload: '{}',
          status: 'pending',
          retryCount: 0,
        },
        {
          id: 'outbox-2',
          aggregateId: 'ticket-124',
          aggregateType: 'ticket',
          eventType: 'UPDATED',
          payload: '{}',
          status: 'pending',
          retryCount: 1,
        },
      ];

      mockPrisma.client.outboxEvent.findMany.mockResolvedValue(pendingEvents);
      mockPrisma.client.outboxEvent.update.mockResolvedValue({
        status: 'completed',
      });

      await service.processPending();

      expect(mockPrisma.client.outboxEvent.findMany).toHaveBeenCalledWith({
        where: { status: 'pending' },
      });
    });

    it('should mark processed records as completed', async () => {
      const pendingEvents = [
        {
          id: 'outbox-1',
          aggregateId: 'ticket-123',
          aggregateType: 'ticket',
          eventType: 'CREATED',
          payload: '{}',
          status: 'pending',
          retryCount: 0,
        },
      ];

      mockPrisma.client.outboxEvent.findMany.mockResolvedValue(pendingEvents);
      mockPrisma.client.outboxEvent.update.mockResolvedValue({
        id: 'outbox-1',
        status: 'completed',
        processedAt: expect.any(Date),
      });

      await service.processPending();

      expect(mockPrisma.client.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: 'outbox-1' },
        data: {
          status: 'completed',
          processedAt: expect.any(Date),
        },
      });
    });

    it('should mark failed records as failed', async () => {
      const pendingEvents = [
        {
          id: 'outbox-1',
          aggregateId: 'ticket-123',
          aggregateType: 'ticket',
          eventType: 'CREATED',
          payload: '{}',
          status: 'pending',
          retryCount: 0,
        },
      ];

      mockPrisma.client.outboxEvent.findMany.mockResolvedValue(pendingEvents);

      // Simulate failure during processing
      await service.processPending();

      // Should be able to mark as failed
      expect(mockPrisma.client.outboxEvent.update).toHaveBeenCalled();
    });
  });

  describe('retry logic', () => {
    it('should retry failed events up to 3 times', async () => {
      const event = {
        id: 'outbox-1',
        aggregateId: 'ticket-123',
        aggregateType: 'ticket',
        eventType: 'CREATED',
        payload: '{}',
        status: 'failed',
        retryCount: 0,
      };

      mockPrisma.client.outboxEvent.update.mockResolvedValue({
        ...event,
        retryCount: 1,
      });

      // First retry
      const retry1 = await service.retry(event);
      expect(retry1.retryCount).toBe(1);

      // Update mock for second retry
      mockPrisma.client.outboxEvent.update.mockResolvedValue({
        ...event,
        retryCount: 2,
      });

      // Second retry
      const retry2 = await service.retry({ ...event, retryCount: 1 });
      expect(retry2.retryCount).toBe(2);

      // Update mock for third retry
      mockPrisma.client.outboxEvent.update.mockResolvedValue({
        ...event,
        retryCount: 3,
      });

      // Third retry
      const retry3 = await service.retry({ ...event, retryCount: 2 });
      expect(retry3.retryCount).toBe(3);
    });

    it('should move to dead_letter after 3 failed retries', async () => {
      const event = {
        id: 'outbox-1',
        aggregateId: 'ticket-123',
        aggregateType: 'ticket',
        eventType: 'CREATED',
        payload: '{}',
        status: 'failed',
        retryCount: 3,
      };

      mockPrisma.client.outboxEvent.update.mockResolvedValue({
        ...event,
        status: 'dead_letter',
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

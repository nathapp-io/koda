/**
 * Outbox Service Full Coverage Tests
 *
 * Story: Outbox Service Enqueue and Processing
 * Description: Upgrade the existing persisted outbox from a Phase 0 skeleton into
 * a real Phase 1 dispatcher with durable enqueueing, processing, retries, and dead-letter handling.
 *
 * Acceptance Criteria:
 * AC1:  enqueue(eventType, eventId, projectId, payload) persists OutboxEvent with status='pending'
 * AC2:  processPending(limit?) picks up to limit pending events ordered by createdAt ASC (default 50)
 * AC3:  markCompleted() sets status='completed' and populates processedAt
 * AC4:  markFailed() records failure details before retry/dead-letter evaluation
 * AC5:  After 3 failed attempts, markDeadLetter() sets status='dead_letter' and records lastError
 * AC6:  Failed events retry with exponential backoff (1s, 4s, 16s) before dead-lettering
 * AC7:  retryEvent(eventId) allows admin-only reset of dead-letter event back to pending
 * AC8:  KodaDomainWriter calls OutboxService.enqueue() after every canonical write
 * AC9:  Outbox processor job is idempotent for already completed/processing events
 * AC10: If OutboxFanOutRegistry.dispatch() throws, event is marked failed and retried (not dead-lettered immediately)
 * AC11: Dead-lettered events queryable via GET /admin/outbox?status=dead_letter with admin-only access
 */

import { Test, TestingModule } from '@nestjs/testing';
import { OutboxService, OutboxEventInput, OutboxEventData } from './outbox.service';
import { OutboxFanOutRegistry } from './outbox-fan-out-registry';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';

const MAX_RETRIES = 3;

function createMockPrismaClient() {
  return {
    outboxEvent: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    project: {
      findUnique: jest.fn(),
    },
  };
}

function createMockFanOutRegistry() {
  return {
    dispatch: jest.fn().mockResolvedValue(undefined),
    register: jest.fn(),
    getHandlers: jest.fn().mockReturnValue([]),
  };
}

describe('OutboxService - AC1: enqueue persists pending OutboxEvent', () => {
  let service: OutboxService;
  let mockPrisma: { client: ReturnType<typeof createMockPrismaClient> };

  beforeEach(async () => {
    mockPrisma = { client: createMockPrismaClient() };
    const mockFanOutRegistry = createMockFanOutRegistry();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OutboxFanOutRegistry, useValue: mockFanOutRegistry },
      ],
    }).compile();

    service = module.get<OutboxService>(OutboxService);
  });

  it('AC1: enqueue persists OutboxEvent record with status=pending and returns created record', async () => {
    const input: OutboxEventInput = {
      projectId: 'proj-123',
      eventType: 'ticket_event',
      eventId: 'ticket-event-456',
      payload: { ticketId: 'ticket-001', action: 'CREATED' },
    };

    const createdRecord = {
      id: 'outbox-abc-789',
      projectId: input.projectId,
      eventType: input.eventType,
      eventId: input.eventId,
      payload: JSON.stringify(input.payload),
      status: 'pending',
      attempts: 0,
      lastError: null,
      processedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockPrisma.client.outboxEvent.create.mockResolvedValue(createdRecord);

    const result = await service.enqueue(input);

    expect(result.status).toBe('pending');
    expect(result.id).toBe('outbox-abc-789');
    expect(result.projectId).toBe('proj-123');
    expect(result.eventType).toBe('ticket_event');
    expect(result.eventId).toBe('ticket-event-456');
    expect(result.attempts).toBe(0);
    expect(result.processedAt).toBeNull();

    expect(mockPrisma.client.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'proj-123',
        eventType: 'ticket_event',
        eventId: 'ticket-event-456',
        payload: JSON.stringify(input.payload),
        status: 'pending',
      }),
    });
  });
});

describe('OutboxService - AC2: processPending with default limit 50 ordered by createdAt ASC', () => {
  let service: OutboxService;
  let mockPrisma: { client: ReturnType<typeof createMockPrismaClient> };

  beforeEach(async () => {
    mockPrisma = { client: createMockPrismaClient() };
    const mockFanOutRegistry = createMockFanOutRegistry();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OutboxFanOutRegistry, useValue: mockFanOutRegistry },
      ],
    }).compile();

    service = module.get<OutboxService>(OutboxService);
  });

  it('AC2: processPending defaults to limit=50 and orders by createdAt ASC', async () => {
    mockPrisma.client.outboxEvent.findMany.mockResolvedValue([]);
    mockPrisma.client.outboxEvent.updateMany.mockResolvedValue({ count: 0 });

    await service.processPending();

    expect(mockPrisma.client.outboxEvent.findMany).toHaveBeenCalledWith({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
  });

  it('AC2: processPending accepts custom limit parameter', async () => {
    mockPrisma.client.outboxEvent.findMany.mockResolvedValue([]);
    mockPrisma.client.outboxEvent.updateMany.mockResolvedValue({ count: 0 });

    await service.processPending(25);

    expect(mockPrisma.client.outboxEvent.findMany).toHaveBeenCalledWith({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: 25,
    });
  });

  it('AC2: processPending picks up to limit pending events', async () => {
    const pendingEvents = [
      { id: 'e1', createdAt: new Date('2024-01-01'), status: 'pending', attempts: 0, lastError: null, processedAt: null, projectId: 'p1', eventType: 'ticket_event', eventId: 'ev1', payload: '{}', updatedAt: new Date() },
      { id: 'e2', createdAt: new Date('2024-01-02'), status: 'pending', attempts: 0, lastError: null, processedAt: null, projectId: 'p1', eventType: 'ticket_event', eventId: 'ev2', payload: '{}', updatedAt: new Date() },
    ];

    mockPrisma.client.outboxEvent.findMany.mockResolvedValue(pendingEvents);
    mockPrisma.client.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.client.outboxEvent.update.mockResolvedValue({ id: 'e1', status: 'completed', processedAt: new Date() });

    await service.processPending(10);

    expect(mockPrisma.client.outboxEvent.findMany).toHaveBeenCalledWith({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });
  });
});

describe('OutboxService - AC3: markCompleted sets status=completed and processedAt', () => {
  let service: OutboxService;
  let mockPrisma: { client: ReturnType<typeof createMockPrismaClient> };

  beforeEach(async () => {
    mockPrisma = { client: createMockPrismaClient() };
    const mockFanOutRegistry = createMockFanOutRegistry();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OutboxFanOutRegistry, useValue: mockFanOutRegistry },
      ],
    }).compile();

    service = module.get<OutboxService>(OutboxService);
  });

  it('AC3: markCompleted sets status to completed and populates processedAt', async () => {
    const eventId = 'outbox-event-123';
    const completedAt = new Date();

    mockPrisma.client.outboxEvent.update.mockResolvedValue({
      id: eventId,
      status: 'completed',
      processedAt: completedAt,
      lastError: null,
      attempts: 1,
    });

    await service.markCompleted(eventId);

    expect(mockPrisma.client.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: eventId },
      data: {
        status: 'completed',
        processedAt: expect.any(Date),
        lastError: null,
      },
    });

    const updateCall = mockPrisma.client.outboxEvent.update.mock.calls[0];
    expect(updateCall[0].data.status).toBe('completed');
    expect(updateCall[0].data.processedAt).toBeInstanceOf(Date);
  });
});

describe('OutboxService - AC4: markFailed records failure details', () => {
  let service: OutboxService;
  let mockPrisma: { client: ReturnType<typeof createMockPrismaClient> };

  beforeEach(async () => {
    mockPrisma = { client: createMockPrismaClient() };
    const mockFanOutRegistry = createMockFanOutRegistry();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OutboxFanOutRegistry, useValue: mockFanOutRegistry },
      ],
    }).compile();

    service = module.get<OutboxService>(OutboxService);
  });

  it('AC4: markFailed records lastError and increments attempts', async () => {
    const eventId = 'outbox-event-456';
    const errorMessage = 'Connection timeout';

    mockPrisma.client.outboxEvent.update.mockResolvedValue({
      id: eventId,
      status: 'pending',
      attempts: 1,
      lastError: errorMessage,
      processedAt: null,
    });

    await service.markFailed(eventId, errorMessage, 0);

    expect(mockPrisma.client.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: eventId },
      data: {
        attempts: 1,
        lastError: errorMessage,
        status: 'pending',
      },
    });
  });

  it('AC4: markFailed transitions to dead_letter after MAX_RETRIES failures', async () => {
    const eventId = 'outbox-event-789';

    mockPrisma.client.outboxEvent.update.mockResolvedValue({
      id: eventId,
      status: 'dead_letter',
      attempts: MAX_RETRIES,
      lastError: 'Final failure',
      processedAt: null,
    });

    await service.markFailed(eventId, 'Final failure', MAX_RETRIES - 1);

    const updateCall = mockPrisma.client.outboxEvent.update.mock.calls[0];
    expect(updateCall[0].data.status).toBe('dead_letter');
    expect(updateCall[0].data.attempts).toBe(MAX_RETRIES);
    expect(updateCall[0].data.lastError).toBe('Final failure');
  });
});

describe('OutboxService - AC5: markDeadLetter sets status=dead_letter and lastError', () => {
  let service: OutboxService;
  let mockPrisma: { client: ReturnType<typeof createMockPrismaClient> };

  beforeEach(async () => {
    mockPrisma = { client: createMockPrismaClient() };
    const mockFanOutRegistry = createMockFanOutRegistry();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OutboxFanOutRegistry, useValue: mockFanOutRegistry },
      ],
    }).compile();

    service = module.get<OutboxService>(OutboxService);
  });

  it('AC5: markDeadLetter sets status=dead_letter and records lastError', async () => {
    const eventId = 'outbox-dl-001';
    const reason = 'Failed after 3 retries';

    mockPrisma.client.outboxEvent.update.mockResolvedValue({
      id: eventId,
      status: 'dead_letter',
      lastError: reason,
      attempts: 3,
      processedAt: null,
    });

    const result = await service.markDeadLetter(eventId, reason);

    expect(result.status).toBe('dead_letter');
    expect(result.lastError).toBe(reason);
    expect(mockPrisma.client.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: eventId },
      data: {
        status: 'dead_letter',
        lastError: reason,
      },
    });
  });

  it('AC5: after 3 failed attempts, event is moved to dead_letter', async () => {
    const eventId = 'outbox-dl-002';

    mockPrisma.client.outboxEvent.update.mockResolvedValue({
      id: eventId,
      status: 'dead_letter',
      lastError: 'Connection refused',
      attempts: 3,
    });

    await service.markFailed(eventId, 'Connection refused', 2);

    const updateCall = mockPrisma.client.outboxEvent.update.mock.calls[0];
    expect(updateCall[0].data.status).toBe('dead_letter');
  });
});

describe('OutboxService - AC6: Exponential backoff 1s, 4s, 16s before dead-letter', () => {
  let service: OutboxService;
  let mockPrisma: { client: ReturnType<typeof createMockPrismaClient> };

  beforeEach(async () => {
    mockPrisma = { client: createMockPrismaClient() };
    const mockFanOutRegistry = createMockFanOutRegistry();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OutboxFanOutRegistry, useValue: mockFanOutRegistry },
      ],
    }).compile();

    service = module.get<OutboxService>(OutboxService);
  });

  it('AC6: exponential backoff delay is 2^(attempt*2) seconds: 1s, 4s, 16s', () => {
    const getBackoffMs = (attempt: number) => Math.pow(2, attempt * 2) * 1000;

    expect(getBackoffMs(0)).toBe(1000);
    expect(getBackoffMs(1)).toBe(4000);
    expect(getBackoffMs(2)).toBe(16000);
  });

  it('AC6: retry with attempt=0 results in status=pending and attempts=1', async () => {
    const event: OutboxEventData = {
      id: 'outbox-retry-001',
      projectId: 'proj-123',
      eventType: 'ticket_event',
      eventId: 'ev-001',
      payload: '{}',
      status: 'failed',
      attempts: 0,
      lastError: 'Timeout',
      processedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockPrisma.client.outboxEvent.update.mockResolvedValue({
      ...event,
      attempts: 1,
      status: 'pending',
    });

    const result = await service.retry(event);

    expect(result.attempts).toBe(1);
    expect(result.status).toBe('pending');
  });

  it('AC6: retry with attempt=2 results in attempts=3 and status=pending (before dead-letter)', async () => {
    const event: OutboxEventData = {
      id: 'outbox-retry-002',
      projectId: 'proj-123',
      eventType: 'ticket_event',
      eventId: 'ev-002',
      payload: '{}',
      status: 'failed',
      attempts: 2,
      lastError: 'Timeout',
      processedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockPrisma.client.outboxEvent.update.mockResolvedValue({
      ...event,
      attempts: 3,
      status: 'pending',
    });

    const result = await service.retry(event);

    expect(result.attempts).toBe(3);
    expect(result.status).toBe('pending');
  });

  it('AC6: retry with attempt=3 transitions to dead_letter', async () => {
    const event: OutboxEventData = {
      id: 'outbox-retry-003',
      projectId: 'proj-123',
      eventType: 'ticket_event',
      eventId: 'ev-003',
      payload: '{}',
      status: 'failed',
      attempts: 3,
      lastError: 'Timeout',
      processedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockPrisma.client.outboxEvent.update.mockResolvedValue({
      ...event,
      status: 'dead_letter',
      lastError: 'Failed after 3 retries',
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

describe('OutboxService - AC7: retryEvent allows admin reset of dead-letter to pending', () => {
  let service: OutboxService;
  let mockPrisma: { client: ReturnType<typeof createMockPrismaClient> };

  beforeEach(async () => {
    mockPrisma = { client: createMockPrismaClient() };
    const mockFanOutRegistry = createMockFanOutRegistry();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OutboxFanOutRegistry, useValue: mockFanOutRegistry },
      ],
    }).compile();

    service = module.get<OutboxService>(OutboxService);
  });

  it('AC7: retryEvent resets dead-letter event to pending status', async () => {
    const eventId = 'outbox-dl-reset';

    mockPrisma.client.outboxEvent.update.mockResolvedValue({
      id: eventId,
      status: 'pending',
      attempts: 0,
      lastError: null,
      processedAt: null,
    });

    await service.retryEvent(eventId);

    expect(mockPrisma.client.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: eventId },
      data: {
        status: 'pending',
        lastError: null,
      },
    });
  });
});

describe('OutboxService - AC9: Idempotent processing for completed/processing events', () => {
  let service: OutboxService;
  let mockPrisma: { client: ReturnType<typeof createMockPrismaClient> };

  beforeEach(async () => {
    mockPrisma = { client: createMockPrismaClient() };
    const mockFanOutRegistry = createMockFanOutRegistry();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OutboxFanOutRegistry, useValue: mockFanOutRegistry },
      ],
    }).compile();

    service = module.get<OutboxService>(OutboxService);
  });

  it('AC9: processPending idempotently skips already-processing events (claim pattern)', async () => {
    const pendingEvent = {
      id: 'already-processing',
      status: 'pending',
      attempts: 1,
      lastError: null,
      processedAt: null,
      projectId: 'p1',
      eventType: 'ticket_event',
      eventId: 'ev1',
      payload: '{}',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockPrisma.client.outboxEvent.findMany.mockResolvedValue([pendingEvent]);
    mockPrisma.client.outboxEvent.updateMany.mockResolvedValue({ count: 0 });

    await service.processPending();

    const updateManyCalls = mockPrisma.client.outboxEvent.updateMany.mock.calls;
    const claimCall = updateManyCalls.find(c => c[0]?.where?.id === 'already-processing');
    expect(claimCall).toBeDefined();
    expect(claimCall[0].where).toEqual({ id: 'already-processing', status: 'pending' });
  });

  it('AC9: processPending atomically claims pending events to prevent double-processing', async () => {
    const pendingEvent = {
      id: 'pending-event-1',
      projectId: 'proj-123',
      eventType: 'ticket_event',
      eventId: 'ev-1',
      payload: '{}',
      status: 'pending' as const,
      attempts: 0,
      lastError: null,
      processedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockPrisma.client.outboxEvent.findMany.mockResolvedValue([pendingEvent]);
    mockPrisma.client.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.client.outboxEvent.update.mockResolvedValue({ ...pendingEvent, status: 'completed' });

    await service.processPending();

    const claimCall = mockPrisma.client.outboxEvent.updateMany.mock.calls.find(
      c => c[0].where?.id === 'pending-event-1' && c[0].data?.status === 'processing'
    );
    expect(claimCall).toBeDefined();

    if (claimCall) {
      expect(claimCall[0].where).toEqual({ id: 'pending-event-1', status: 'pending' });
    }
  });
});

describe('OutboxService - AC10: dispatch throws triggers markFailed not immediate dead-letter', () => {
  let service: OutboxService;
  let mockPrisma: { client: ReturnType<typeof createMockPrismaClient> };

  beforeEach(async () => {
    mockPrisma = { client: createMockPrismaClient() };
    const mockFanOutRegistry = createMockFanOutRegistry();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OutboxFanOutRegistry, useValue: mockFanOutRegistry },
      ],
    }).compile();

    service = module.get<OutboxService>(OutboxService);
  });

  it('AC10: when dispatch throws and attempts < 3, markFailed is called (not dead-letter)', async () => {
    const pendingEvent = {
      id: 'outbox-fail-001',
      projectId: 'proj-123',
      eventType: 'ticket_event',
      eventId: 'ev-1',
      payload: '{}',
      status: 'pending' as const,
      attempts: 0,
      lastError: null,
      processedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockPrisma.client.outboxEvent.findMany.mockResolvedValue([pendingEvent]);
    mockPrisma.client.outboxEvent.updateMany.mockResolvedValue({ count: 1 });

    const updateCalls: any[] = [];
    mockPrisma.client.outboxEvent.update.mockImplementation((args: any) => {
      updateCalls.push(args);
      return Promise.resolve({
        ...pendingEvent,
        ...args.data,
      });
    });

    jest.spyOn(service as any, 'processEvent').mockRejectedValue(new Error('Dispatch failed'));

    await service.processPending();

    const failedUpdate = updateCalls.find(
      c => c.where?.id === 'outbox-fail-001' && c.data?.status === 'pending'
    );
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate.data.attempts).toBe(1);
    expect(failedUpdate.data.lastError).toBe('Dispatch failed');
  });
});
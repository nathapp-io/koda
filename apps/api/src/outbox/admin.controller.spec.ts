/**
 * Outbox Admin Controller Tests
 *
 * Story: Outbox Service Enqueue and Processing
 *
 * Acceptance Criteria:
 * AC11: GET /admin/outbox?status=dead_letter with admin-only access
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { AdminController } from './admin.controller';
import { OutboxService, OutboxEventData } from './outbox.service';

type AdminUser = { extra?: { role?: string } } | null;

function createMockOutboxService() {
  return {
    getPendingEvents: jest.fn(),
    getDeadLetterEvents: jest.fn(),
    getEventsByStatus: jest.fn(),
  };
}

describe('AdminController - AC11: Dead-letter query with admin-only access', () => {
  let controller: AdminController;
  let mockOutboxService: ReturnType<typeof createMockOutboxService>;

  beforeEach(async () => {
    mockOutboxService = createMockOutboxService();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        { provide: OutboxService, useValue: mockOutboxService },
      ],
    }).compile();

    controller = module.get<AdminController>(AdminController);
  });

  describe('GET /admin/outbox', () => {
    it('AC11: request with admin role returns HTTP 200 with events', async () => {
      const events: OutboxEventData[] = [
        {
          id: 'dl-001',
          projectId: 'proj-123',
          eventType: 'ticket_event',
          eventId: 'ev-001',
          payload: '{}',
          status: 'dead_letter',
          attempts: 3,
          lastError: 'Connection refused',
          processedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'dl-002',
          projectId: 'proj-123',
          eventType: 'agent_event',
          eventId: 'ev-002',
          payload: '{}',
          status: 'dead_letter',
          attempts: 3,
          lastError: 'Timeout',
          processedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockOutboxService.getPendingEvents.mockResolvedValue(events);

      const adminUser: AdminUser = { extra: { role: 'ADMIN' } };
      const result = await controller.getOutbox(adminUser);

      expect(result).toEqual({
        items: events,
        total: 2,
      });
    });

    it('AC11: request without admin credentials returns HTTP 403 Forbidden', async () => {
      const nonAdminUser: AdminUser = { extra: { role: 'MEMBER' } };

      await expect(controller.getOutbox(nonAdminUser)).rejects.toThrow(ForbiddenAppException);
    });

    it('AC11: request with null user returns HTTP 403 Forbidden', async () => {
      const nullUser: AdminUser = null;

      await expect(controller.getOutbox(nullUser)).rejects.toThrow(ForbiddenAppException);
    });

    it('AC11: request with undefined extra returns HTTP 403 Forbidden', async () => {
      const userWithNoExtra: AdminUser = {};

      await expect(controller.getOutbox(userWithNoExtra)).rejects.toThrow(ForbiddenAppException);
    });
  });
});

describe('AdminController - Additional admin outbox queries', () => {
  let controller: AdminController;
  let mockOutboxService: ReturnType<typeof createMockOutboxService>;

  beforeEach(async () => {
    mockOutboxService = createMockOutboxService();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        { provide: OutboxService, useValue: mockOutboxService },
      ],
    }).compile();

    controller = module.get<AdminController>(AdminController);
  });

  it('returns pending events by default', async () => {
    const pendingEvents: OutboxEventData[] = [
      {
        id: 'p-001',
        projectId: 'proj-123',
        eventType: 'ticket_event',
        eventId: 'ev-001',
        payload: '{}',
        status: 'pending',
        attempts: 0,
        lastError: null,
        processedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    mockOutboxService.getPendingEvents.mockResolvedValue(pendingEvents);

    const adminUser: AdminUser = { extra: { role: 'ADMIN' } };
    const result = await controller.getOutbox(adminUser);

    expect(mockOutboxService.getPendingEvents).toHaveBeenCalled();
    expect(result.items).toHaveLength(1);
    expect(result.items[0].status).toBe('pending');
  });

  it('returns events with total count', async () => {
    const events: OutboxEventData[] = [
      {
        id: 'e-001',
        projectId: 'proj-123',
        eventType: 'ticket_event',
        eventId: 'ev-001',
        payload: '{}',
        status: 'processing',
        attempts: 1,
        lastError: null,
        processedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    mockOutboxService.getPendingEvents.mockResolvedValue(events);

    const adminUser: AdminUser = { extra: { role: 'ADMIN' } };
    const result = await controller.getOutbox(adminUser);

    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
  });
});
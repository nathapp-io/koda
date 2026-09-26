import { HttpException, HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AdminController } from './admin.controller';
import { OutboxAdminService } from './outbox-admin.service';

type AdminUser = {
  actorType: 'user';
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'MEMBER';
  blacklisted: boolean;
  revoked: boolean;
  authorities: string[];
  extra: { sub: string };
};

const adminUser: AdminUser = {
  actorType: 'user',
  id: 'user-admin',
  name: 'admin@example.com',
  email: 'admin@example.com',
  role: 'ADMIN',
  blacklisted: false,
  revoked: false,
  authorities: ['ADMIN'],
  extra: { sub: 'user-admin' },
};

const deadEvent = {
  id: 'dl-001',
  projectId: 'proj-123',
  type: 'ticket_event',
  eventId: 'ev-001',
  payload: '{}',
  headers: null,
  status: 'dead',
  attempts: 3,
  nextAttemptAt: new Date(),
  leaseUntil: null,
  owner: null,
  lastError: 'Connection refused',
  publishedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function createMockOutboxAdminService() {
  return {
    list: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    retry: jest.fn().mockResolvedValue(undefined),
  };
}

describe('AdminController', () => {
  let controller: AdminController;
  let mockOutboxAdminService: ReturnType<typeof createMockOutboxAdminService>;

  beforeEach(async () => {
    mockOutboxAdminService = createMockOutboxAdminService();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        { provide: OutboxAdminService, useValue: mockOutboxAdminService },
      ],
    }).compile();

    controller = module.get<AdminController>(AdminController);
  });

  describe('GET /admin/outbox', () => {
    it('lists pending events by default and returns items with a total count', async () => {
      const result = await controller.getOutbox(adminUser, {});

      expect(mockOutboxAdminService.list).toHaveBeenCalledWith(undefined);
      expect(result).toEqual({ items: [], total: 0 });
    });

    it('passes the requested status through to the service', async () => {
      mockOutboxAdminService.list.mockResolvedValue({ items: [deadEvent], total: 1 });

      const result = await controller.getOutbox(adminUser, { status: 'dead' as never });

      expect(mockOutboxAdminService.list).toHaveBeenCalledWith('dead');
      expect(result).toEqual({
        items: [deadEvent],
        total: 1,
      });
    });
  });

  describe('POST /admin/outbox/:eventId/retry', () => {
    it('delegates the event id to the service', async () => {
      await controller.retryOutboxEvent(adminUser, 'dl-001');

      expect(mockOutboxAdminService.retry).toHaveBeenCalledWith('dl-001');
    });

    it('propagates a 404 from the service (unknown event)', async () => {
      mockOutboxAdminService.retry.mockRejectedValue(
        new HttpException('Outbox event not found', HttpStatus.NOT_FOUND),
      );

      await expect(controller.retryOutboxEvent(adminUser, 'missing')).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
      });
    });

    it('propagates a 409 from the service (processing or published)', async () => {
      mockOutboxAdminService.retry.mockRejectedValue(
        new HttpException('Outbox event is processing; only dead or pending events can be retried', HttpStatus.CONFLICT),
      );

      await expect(controller.retryOutboxEvent(adminUser, 'dl-001')).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
      });
    });
  });
});

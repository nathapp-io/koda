import { ApprovalRouteGate } from '../approvals/route/approval-route-gate';
import { HttpException, HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PermissionService } from '../permissions/permission.service';
import { REQUIRES_METADATA } from '../permissions/requires.decorator';
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
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    retry: vi.fn().mockResolvedValue(undefined),
  };
}

describe('AdminController', () => {
  let controller: AdminController;
  let gate: { run: ReturnType<typeof vi.fn> };
  let moduleRef: TestingModule;
  let mockOutboxAdminService: ReturnType<typeof createMockOutboxAdminService>;

  beforeEach(async () => {
    mockOutboxAdminService = createMockOutboxAdminService();
    gate = { run: vi.fn().mockResolvedValue({ status: 'executed', result: null }) };

    moduleRef = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        { provide: ApprovalRouteGate, useValue: gate },
        { provide: OutboxAdminService, useValue: mockOutboxAdminService },
        // Permissions P1 (US-010): the controller runs `RequiresGuard`, whose one dependency is the
        // decision point the global PermissionsModule exports.
        {
          provide: PermissionService,
          useValue: { can: vi.fn(async () => ({ allowed: true, reason: 'granted' })) },
        },
      ],
    }).compile();

    controller = moduleRef.get<AdminController>(AdminController);
  });

  afterEach(async () => {
    await moduleRef?.close();
  });

  it.each([
    ['getOutbox', 'outbox.read'],
    ['retryOutboxEvent', 'outbox.retry'],
  ] as const)('%s declares @Requires(%s)', (handler, key) => {
    const fn = (AdminController.prototype as unknown as Record<string, object>)[handler];
    expect(Reflect.getMetadata(REQUIRES_METADATA, fn)).toEqual({
      keys: [key],
      mode: 'all',
      enforcedBy: 'guard',
    });
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
    it('delegates the event id to the gate', async () => {
      await controller.retryOutboxEvent(adminUser, 'dl-001');

      expect(gate.run).toHaveBeenCalledWith({ key: 'outbox.retry', variant: 'rest:admin-outbox.retry', projectId: null, input: { eventId: 'dl-001' } });
    });

    it('propagates a 404 from the gated command (unknown event)', async () => {
      gate.run.mockRejectedValue(
        new HttpException('Outbox event not found', HttpStatus.NOT_FOUND),
      );

      await expect(controller.retryOutboxEvent(adminUser, 'missing')).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
      });
    });

    it('propagates a 409 from the gated command (processing or published)', async () => {
      gate.run.mockRejectedValue(
        new HttpException('Outbox event is processing; only dead or pending events can be retried', HttpStatus.CONFLICT),
      );

      await expect(controller.retryOutboxEvent(adminUser, 'dl-001')).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
      });
    });
  });
});

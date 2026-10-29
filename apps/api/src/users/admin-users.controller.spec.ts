import { ApprovalPending } from '../approvals/route/approval-pending';
import { PERMISSION_KEY } from '@nathapp/nestjs-auth';
import { REQUIRES_METADATA } from '../permissions/requires.decorator';
import { AdminUsersController } from './admin-users.controller';

describe('US-010 permission keys on the admin user routes', () => {
  it.each([
    ['list', 'user.read'],
    ['create', 'user.create'],
    ['update', 'user.update'],
  ] as const)('%s declares @Requires(%s) and no legacy ADMIN gate', (handler, key) => {
    const fn = (AdminUsersController.prototype as unknown as Record<string, object>)[handler];

    expect(Reflect.getMetadata(REQUIRES_METADATA, fn)).toEqual({
      keys: [key],
      mode: 'all',
      enforcedBy: 'guard',
    });
    expect(Reflect.getMetadata(PERMISSION_KEY, fn)).toBeUndefined();
  });
});

describe('AdminUsersController', () => {
  const service = { list: vi.fn(), create: vi.fn(), update: vi.fn() };
  const gate = { run: vi.fn() };
  const controller = new AdminUsersController(service as never, gate as never);
  const page = { total: 1, current: 2, size: 5, hasNext: false, hasPrev: true, records: [{ id: 'u1' }] };

  beforeEach(() => vi.resetAllMocks());

  it('parses paging strings and forwards the email filter', async () => {
    service.list.mockResolvedValue(page);
    const res = await controller.list({ current: '2', size: '5', email: 'bob' } as never);
    expect(service.list).toHaveBeenCalledWith({ email: 'bob' }, { current: 2, size: 5 });
    expect(res).toEqual(expect.objectContaining({ ret: 0, data: page }));
  });

  it('maps pending updates to ApprovalPending', async () => {
    gate.run.mockResolvedValue({ status: 'pending', request: { id: 'approval-1' } });
    await expect(controller.update('u2', { disabled: true }, { id: 'u1' } as never)).rejects.toBeInstanceOf(ApprovalPending);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('gates the update and retains the response envelope', async () => {
    gate.run.mockResolvedValue({ status: 'executed', result: { id: 'u2' } });
    const result = await controller.update('u2', { disabled: true }, { id: 'u1', actorType: 'user' } as never);
    expect(gate.run).toHaveBeenCalledWith({ key: 'user.update', variant: 'rest:admin-users.update', projectId: null, input: { id: 'u2', patch: { disabled: true } } });
    expect(result).toMatchObject({ ret: 0, data: { id: 'u2' } });
    expect(service.update).not.toHaveBeenCalled();
  });
});

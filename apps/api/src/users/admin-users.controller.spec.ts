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
  const controller = new AdminUsersController(service as never);
  const page = { total: 1, current: 2, size: 5, hasNext: false, hasPrev: true, records: [{ id: 'u1' }] };

  afterEach(() => vi.clearAllMocks());

  it('parses paging strings and forwards the email filter', async () => {
    service.list.mockResolvedValue(page);
    const res = await controller.list({ current: '2', size: '5', email: 'bob' } as never);
    expect(service.list).toHaveBeenCalledWith({ email: 'bob' }, { current: 2, size: 5 });
    expect(res).toEqual(expect.objectContaining({ ret: 0, data: page }));
  });

  it('passes the acting principal id to update', async () => {
    service.update.mockResolvedValue({ id: 'u2' });
    await controller.update('u2', { disabled: true }, { id: 'u1', actorType: 'user' } as never);
    expect(service.update).toHaveBeenCalledWith('u1', 'u2', { disabled: true });
  });
});

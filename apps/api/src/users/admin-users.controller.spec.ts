import { PERMISSION_KEY } from '@nathapp/nestjs-auth';
import { AdminUsersController } from './admin-users.controller';

describe('AdminUsersController', () => {
  const service = { list: jest.fn(), create: jest.fn(), update: jest.fn() };
  const controller = new AdminUsersController(service as never);
  const page = { total: 1, current: 2, size: 5, hasNext: false, hasPrev: true, records: [{ id: 'u1' }] };

  afterEach(() => jest.clearAllMocks());

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

  it.each(['list', 'create', 'update'] as const)('%s requires the global ADMIN permission', (method) => {
    const perms = Reflect.getMetadata(PERMISSION_KEY, AdminUsersController.prototype[method]);
    expect(JSON.stringify(perms)).toContain('ADMIN');
  });
});

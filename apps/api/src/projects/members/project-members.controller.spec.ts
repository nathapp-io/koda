import { ProjectMembersController } from './project-members.controller';
import { REQUIRES_METADATA } from '../../permissions/requires.decorator';

describe('US-008 permission keys on member routes', () => {
  it.each([
    ['list', 'member.read'],
    ['add', 'member.add'],
    ['updateRole', 'role.binding.manage'],
    ['remove', 'member.remove'],
  ] as const)('%s declares @Requires(%s)', (handler, key) => {
    const fn = (ProjectMembersController.prototype as unknown as Record<string, object>)[handler];
    expect(Reflect.getMetadata(REQUIRES_METADATA, fn)).toEqual({
      keys: [key],
      mode: 'all',
      enforcedBy: 'guard',
    });
  });

  it('runs ProjectMembershipGuard before RequiresGuard at the class level', () => {
    const guards = (Reflect.getMetadata('__guards__', ProjectMembersController) ?? []) as unknown[];

    expect(guards.map((guard) => (guard as { name?: string }).name)).toEqual([
      'ProjectMembershipGuard',
      'RequiresGuard',
    ]);
  });
});

describe('ProjectMembersController', () => {
  const service = { list: vi.fn(), add: vi.fn(), updateRole: vi.fn(), remove: vi.fn() };
  const controller = new ProjectMembersController(service as never);
  const principal = { actorType: 'user', id: 'u1' } as never;

  afterEach(() => vi.clearAllMocks());

  it('list parses paging strings and returns the page envelope with canManage', async () => {
    const page = { total: 0, current: 2, size: 5, hasNext: false, hasPrev: true, records: [] };
    service.list.mockResolvedValue({ page, canManage: true, viewerRole: 'ADMIN' });
    const res = await controller.list('proj', { current: '2', size: '5' } as never, principal);
    expect(service.list).toHaveBeenCalledWith('proj', principal, { current: 2, size: 5 }, undefined);
    expect(res).toEqual(expect.objectContaining({ ret: 0, data: { ...page, canManage: true, viewerRole: 'ADMIN' } }));
  });

  it('list ignores undeclared query keys', async () => {
    service.list.mockResolvedValue({
      page: { total: 0, current: 1, size: 20, hasNext: false, hasPrev: false, records: [] },
      canManage: false,
    });
    await controller.list('proj', { projectId: 'other' } as never, principal);
    expect(service.list).toHaveBeenCalledWith('proj', principal, { current: 1, size: 20 }, undefined);
  });

  it('US-003: list forwards principals=all', async () => {
    service.list.mockResolvedValue({
      page: { total: 0, current: 1, size: 20, hasNext: false, hasPrev: false, records: [] },
      canManage: false,
    });
    await controller.list('proj', { principals: 'all' } as never, principal);
    expect(service.list).toHaveBeenCalledWith('proj', principal, { current: 1, size: 20 }, 'all');
  });

  it('remove returns an empty Ok', async () => {
    const res = await controller.remove('proj', 'u2', principal);
    expect(service.remove).toHaveBeenCalledWith('proj', 'u2', principal);
    expect(res).toEqual(expect.objectContaining({ ret: 0 }));
  });
});

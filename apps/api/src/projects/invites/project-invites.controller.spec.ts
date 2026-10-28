import { ApprovalPending } from '../../approvals/route/approval-pending';
import { REQUIRES_METADATA } from '../../permissions/requires.decorator';
import { ProjectInvitesController } from './project-invites.controller';

describe('US-008 permission keys on invite routes', () => {
  it.each([
    ['list', 'invite.read'],
    ['create', 'invite.create'],
    ['resend', 'invite.resend'],
    ['cancel', 'invite.cancel'],
  ] as const)('%s declares @Requires(%s)', (handler, key) => {
    const fn = (ProjectInvitesController.prototype as unknown as Record<string, object>)[handler];
    expect(Reflect.getMetadata(REQUIRES_METADATA, fn)).toEqual({
      keys: [key],
      mode: 'all',
      enforcedBy: 'guard',
    });
  });

  it('runs ProjectMembershipGuard before RequiresGuard at the class level', () => {
    const guards = (Reflect.getMetadata('__guards__', ProjectInvitesController) ?? []) as unknown[];

    expect(guards.map((guard) => (guard as { name?: string }).name)).toEqual([
      'ProjectMembershipGuard',
      'RequiresGuard',
    ]);
  });
});

describe('ProjectInvitesController', () => {
  const service = { list: vi.fn(), create: vi.fn(), resend: vi.fn(), cancel: vi.fn() };
  const gate = { run: vi.fn() };
  const controller = new ProjectInvitesController(service as never, gate as never);
  const principal = { actorType: 'user', id: 'u1' } as never;

  it('cancel throws ApprovalPending when waiting', async () => {
    gate.run.mockResolvedValue({ status: 'pending', request: { id: 'r1' } });
    await expect(controller.cancel('proj', 'i1', principal, { project: { id: 'p1' } } as never)).rejects.toBeInstanceOf(ApprovalPending);
  });

  afterEach(() => vi.resetAllMocks());

  it('list hands the slug and principal to the service and wraps the array', async () => {
    service.list.mockResolvedValue([{ id: 'i1' }]);

    const res = await controller.list('proj', principal);

    expect(service.list).toHaveBeenCalledWith('proj', principal);
    expect(res).toEqual(expect.objectContaining({ ret: 0, data: [{ id: 'i1' }] }));
  });

  it('create passes the accept-language locale through', async () => {
    service.create.mockResolvedValue({ outcome: 'INVITED' });

    const res = await controller.create('proj', { email: 'a@k.t', role: 'VIEWER' } as never, principal, 'zh-CN');

    expect(service.create).toHaveBeenCalledWith('proj', { email: 'a@k.t', role: 'VIEWER' }, principal, 'zh');
    expect(res).toEqual(expect.objectContaining({ ret: 0 }));
  });

  it('cancel returns an empty Ok', async () => {
    gate.run.mockResolvedValue({ status: 'executed', result: null });

    const res = await controller.cancel('proj', 'i1', principal, { project: { id: 'p1' } } as never);

    expect(gate.run).toHaveBeenCalledWith({ key: 'invite.cancel', variant: 'rest:project-invites.cancel', projectId: 'p1', input: { slug: 'proj', id: 'i1' } });
    expect(service.cancel).not.toHaveBeenCalled();
    expect(res.data).toEqual({});
    expect(res).toEqual(expect.objectContaining({ ret: 0 }));
  });
});

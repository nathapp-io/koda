import type { Mock } from 'vitest';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { Prisma } from '../../generated/prisma/client';
import { ProjectMembersService } from './project-members.service';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';

const globalAdmin = { actorType: 'user', id: 'g1', role: 'ADMIN', email: 'g@k.t' } as KodaPrincipal;
const projectAdmin = { actorType: 'user', id: 'pa', role: 'MEMBER', email: 'pa@k.t' } as KodaPrincipal;
const member = (userId: string, role: string, disabled = false) =>
  ({ userId, email: `${userId}@k.t`, name: userId, role, disabled, joinedAt: new Date(0) });

describe('ProjectMembersService', () => {
  let repo: Record<string, Mock>;
  let access: Record<string, Mock>;
  let service: ProjectMembersService;

  beforeEach(() => {
    repo = {
      findMemberPage: vi.fn(),
      findMember: vi.fn(),
      findUserByEmail: vi.fn(),
      findUserIdByEmail: vi.fn(),
      createMember: vi.fn(async (_p: string, userId: string, role: string) => member(userId, role)),
      updateMemberRole: vi.fn(async (_p: string, userId: string, role: string) => member(userId, role)),
      deleteMember: vi.fn(),
      countProjectAdmins: vi.fn(),
      lockMembers: vi.fn(),
    };
    access = {
      findProjectIdBySlug: vi.fn().mockResolvedValue('p1'),
      assertProjectMembership: vi.fn(),
      assertProjectAdmin: vi.fn(),
      canManageMembers: vi.fn(),
      resolveMembership: vi.fn(),
    };
    const txManager = { run: <T>(fn: () => Promise<T>) => fn(), isInTransaction: () => false };
    service = new ProjectMembersService(repo as never, access as never, txManager as never);
  });

  it('list resolves membership once and derives canManage and viewerRole from it', async () => {
    repo.findMemberPage.mockResolvedValue({ total: 0, current: 1, size: 20, hasNext: false, hasPrev: false, records: [] });
    access.resolveMembership.mockResolvedValue('ADMIN');

    const result = await service.list('proj', projectAdmin, { current: 1, size: 20 });

    expect(access.resolveMembership).toHaveBeenCalledTimes(1);
    expect(access.canManageMembers).not.toHaveBeenCalled();
    expect(result.canManage).toBe(true);
    expect(result.viewerRole).toBe('ADMIN');
    expect(result.page.total).toBe(0);
  });

  it('list reports viewerRole DEVELOPER and canManage false for a developer', async () => {
    repo.findMemberPage.mockResolvedValue({ total: 0, current: 1, size: 20, hasNext: false, hasPrev: false, records: [] });
    access.resolveMembership.mockResolvedValue('DEVELOPER');

    const result = await service.list('proj', projectAdmin, { current: 1, size: 20 });

    expect(result).toEqual(expect.objectContaining({ canManage: false, viewerRole: 'DEVELOPER' }));
  });

  it('list reports viewerRole null and canManage false for an agent', async () => {
    repo.findMemberPage.mockResolvedValue({ total: 0, current: 1, size: 20, hasNext: false, hasPrev: false, records: [] });
    access.resolveMembership.mockResolvedValue(null);

    const result = await service.list('proj', projectAdmin, { current: 1, size: 20 });

    expect(result).toEqual(expect.objectContaining({ canManage: false, viewerRole: null }));
  });

  it('writes are gated by assertProjectAdmin', async () => {
    access.assertProjectAdmin.mockRejectedValue(new ForbiddenAppException({}, 'members'));
    await expect(service.add('proj', { email: 'x@k.t', role: 'VIEWER' }, projectAdmin)).rejects.toBeInstanceOf(ForbiddenAppException);
    await expect(service.updateRole('proj', 'u1', { role: 'VIEWER' }, projectAdmin)).rejects.toBeInstanceOf(ForbiddenAppException);
    await expect(service.remove('proj', 'u1', projectAdmin)).rejects.toBeInstanceOf(ForbiddenAppException);
    expect(repo.createMember).not.toHaveBeenCalled();
  });

  it('add: unknown email is 404, duplicate member is 409', async () => {
    repo.findUserByEmail.mockResolvedValueOnce(null);
    repo.findUserIdByEmail.mockResolvedValueOnce(null);
    await expect(service.add('proj', { email: 'ghost@k.t', role: 'VIEWER' }, globalAdmin)).rejects.toBeInstanceOf(NotFoundAppException);

    repo.findUserByEmail.mockResolvedValueOnce({ id: 'u1', disabled: false });
    repo.findUserIdByEmail.mockResolvedValueOnce('u1');
    repo.createMember.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002', clientVersion: 'test', meta: { target: ['projectId', 'userId'] },
    }));
    await expect(service.add('proj', { email: 'u1@k.t', role: 'VIEWER' }, globalAdmin)).rejects.toBeInstanceOf(ConflictAppException);
  });

  it('AC14: refuses to add a disabled user without creating membership', async () => {
    repo.findUserByEmail.mockResolvedValue({ id: 'disabled-user', disabled: true });
    repo.findUserIdByEmail.mockResolvedValue('disabled-user');

    // The disabled refusal is the `members.userDisabled.409` AppException (the
    // i18n key lives in `prefix`; the HTTP body renders it through the global
    // exception filter, which a service-level test does not run).
    const error = await service.add('proj', { email: 'disabled@k.t', role: 'VIEWER' }, globalAdmin)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictAppException);
    expect((error as ConflictAppException).prefix).toBe('members.userDisabled');
    expect((error as ConflictAppException).httpStatus).toBe(409);

    expect(repo.createMember).not.toHaveBeenCalled();
  });

  it('AC15: lists each member disabled state', async () => {
    repo.findMemberPage.mockResolvedValue({
      total: 2,
      current: 1,
      size: 20,
      hasNext: false,
      hasPrev: false,
      records: [member('disabled-user', 'VIEWER', true), member('enabled-user', 'DEVELOPER', false)],
    });
    access.resolveMembership.mockResolvedValue('ADMIN');

    const result = await service.list('proj', projectAdmin, { current: 1, size: 20 });

    expect(result.page.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: 'disabled-user', disabled: true }),
      expect.objectContaining({ userId: 'enabled-user', disabled: false }),
    ]));
  });

  it('updateRole/remove 404 a non-member', async () => {
    repo.findMember.mockResolvedValue(null);
    await expect(service.updateRole('proj', 'nobody', { role: 'VIEWER' }, globalAdmin)).rejects.toBeInstanceOf(NotFoundAppException);
    await expect(service.remove('proj', 'nobody', globalAdmin)).rejects.toBeInstanceOf(NotFoundAppException);
  });

  it('a project admin cannot demote or remove the last project ADMIN', async () => {
    repo.findMember.mockResolvedValue(member('pa', 'ADMIN'));
    repo.countProjectAdmins.mockResolvedValue(1);

    await expect(service.updateRole('proj', 'pa', { role: 'DEVELOPER' }, projectAdmin)).rejects.toBeInstanceOf(ConflictAppException);
    await expect(service.remove('proj', 'pa', projectAdmin)).rejects.toBeInstanceOf(ConflictAppException);
    expect(repo.lockMembers.mock.invocationCallOrder[0]).toBeLessThan(repo.countProjectAdmins.mock.invocationCallOrder[0]);
    expect(repo.updateMemberRole).not.toHaveBeenCalled();
    expect(repo.deleteMember).not.toHaveBeenCalled();
  });

  it('a global ADMIN may remove the last project ADMIN', async () => {
    repo.findMember.mockResolvedValue(member('pa', 'ADMIN'));
    repo.countProjectAdmins.mockResolvedValue(1);

    await service.remove('proj', 'pa', globalAdmin);

    expect(repo.deleteMember).toHaveBeenCalledWith('p1', 'pa');
    expect(repo.countProjectAdmins).not.toHaveBeenCalled();
  });

  it('keeping ADMIN, or changing a non-admin, needs no count', async () => {
    repo.findMember.mockResolvedValue(member('d1', 'DEVELOPER'));
    await service.updateRole('proj', 'd1', { role: 'VIEWER' }, projectAdmin);
    expect(repo.countProjectAdmins).not.toHaveBeenCalled();
  });

  it('a disabled ADMIN does not trigger the last-admin guard', async () => {
    repo.findMember.mockResolvedValue(member('dis', 'ADMIN', true));

    await service.remove('proj', 'dis', projectAdmin);

    expect(repo.deleteMember).toHaveBeenCalledWith('p1', 'dis');
    expect(repo.countProjectAdmins).not.toHaveBeenCalled();
  });
});

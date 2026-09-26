import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { Prisma } from '@prisma/client';
import { ProjectMembersService } from './project-members.service';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';

const globalAdmin = { actorType: 'user', id: 'g1', role: 'ADMIN', email: 'g@k.t' } as KodaPrincipal;
const projectAdmin = { actorType: 'user', id: 'pa', role: 'MEMBER', email: 'pa@k.t' } as KodaPrincipal;
const member = (userId: string, role: string) => ({ userId, email: `${userId}@k.t`, name: userId, role, joinedAt: new Date(0) });

describe('ProjectMembersService', () => {
  let repo: Record<string, jest.Mock>;
  let access: Record<string, jest.Mock>;
  let service: ProjectMembersService;

  beforeEach(() => {
    repo = {
      findMemberPage: jest.fn(),
      findMember: jest.fn(),
      findUserIdByEmail: jest.fn(),
      createMember: jest.fn(async (_p: string, userId: string, role: string) => member(userId, role)),
      updateMemberRole: jest.fn(async (_p: string, userId: string, role: string) => member(userId, role)),
      deleteMember: jest.fn(),
      countProjectAdmins: jest.fn(),
      lockMembers: jest.fn(),
    };
    access = {
      findProjectIdBySlug: jest.fn().mockResolvedValue('p1'),
      assertProjectMembership: jest.fn(),
      assertProjectAdmin: jest.fn(),
    };
    const txManager = { run: <T>(fn: () => Promise<T>) => fn(), isInTransaction: () => false };
    service = new ProjectMembersService(repo as never, access as never, txManager as never);
  });

  it('list checks membership, not admin rights', async () => {
    repo.findMemberPage.mockResolvedValue({ total: 0, current: 1, size: 20, hasNext: false, hasPrev: false, records: [] });
    await service.list('proj', projectAdmin, { current: 1, size: 20 });
    expect(access.assertProjectMembership).toHaveBeenCalledWith('p1', projectAdmin);
    expect(access.assertProjectAdmin).not.toHaveBeenCalled();
  });

  it('writes are gated by assertProjectAdmin', async () => {
    access.assertProjectAdmin.mockRejectedValue(new ForbiddenAppException({}, 'members'));
    await expect(service.add('proj', { email: 'x@k.t', role: 'VIEWER' }, projectAdmin)).rejects.toBeInstanceOf(ForbiddenAppException);
    await expect(service.updateRole('proj', 'u1', { role: 'VIEWER' }, projectAdmin)).rejects.toBeInstanceOf(ForbiddenAppException);
    await expect(service.remove('proj', 'u1', projectAdmin)).rejects.toBeInstanceOf(ForbiddenAppException);
    expect(repo.createMember).not.toHaveBeenCalled();
  });

  it('add: unknown email is 404, duplicate member is 409', async () => {
    repo.findUserIdByEmail.mockResolvedValueOnce(null);
    await expect(service.add('proj', { email: 'ghost@k.t', role: 'VIEWER' }, globalAdmin)).rejects.toBeInstanceOf(NotFoundAppException);

    repo.findUserIdByEmail.mockResolvedValueOnce('u1');
    repo.createMember.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002', clientVersion: 'test', meta: { target: ['projectId', 'userId'] },
    }));
    await expect(service.add('proj', { email: 'u1@k.t', role: 'VIEWER' }, globalAdmin)).rejects.toBeInstanceOf(ConflictAppException);
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
});

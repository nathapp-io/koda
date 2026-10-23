import { Logger } from '@nestjs/common';
import { createMockPrismaService } from '@nathapp/nestjs-prisma';
import { MEMBERSHIP_READ_CAP } from '../permissions/membership.queries';
import { PrismaUsersRepository } from './prisma-users.repository';

function mockPrisma() {
  const prisma = createMockPrismaService({ fn: vi.fn });
  prisma.client.roleBinding = { findMany: vi.fn() };
  prisma.client.user = { count: vi.fn() };
  return prisma;
}

describe('PrismaUsersRepository active admins', () => {
  afterEach(() => vi.restoreAllMocks());

  it('bounds its global USER binding scan and counts distinct enabled users', async () => {
    const prisma = mockPrisma();
    prisma.client.roleBinding.findMany.mockResolvedValue([{ principalId: 'u1' }, { principalId: 'u1' }, { principalId: 'u2' }] as never);
    prisma.client.user.count.mockResolvedValue(1);
    const repo = new PrismaUsersRepository(prisma as never);

    expect(await repo.countActiveAdmins()).toBe(1);
    expect(prisma.client.roleBinding.findMany).toHaveBeenCalledWith({
      where: { principalType: 'USER', projectId: null, role: { key: { in: ['owner', 'admin'] } } },
      select: { principalId: true }, take: MEMBERSHIP_READ_CAP,
    });
    expect(prisma.client.user.count).toHaveBeenCalledWith({ where: { id: { in: ['u1', 'u2'] }, disabled: false } });
  });

  it('warns on a capped scan and answers only from that first page', async () => {
    const prisma = mockPrisma();
    prisma.client.roleBinding.findMany.mockResolvedValue(Array.from({ length: MEMBERSHIP_READ_CAP }, () => ({ principalId: 'u1' })) as never);
    prisma.client.user.count.mockResolvedValue(1);
    const warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
    expect(await new PrismaUsersRepository(prisma as never).countActiveAdmins()).toBe(1);
    expect(warn).toHaveBeenCalledWith(`countActiveAdmins read its ${MEMBERSHIP_READ_CAP}-row cap for global admins and answered the first page`);
    expect(prisma.client.roleBinding.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.client.user.count).toHaveBeenCalledWith({ where: { id: { in: ['u1'] }, disabled: false } });
  });

  it('propagates binding read failures rather than counting legacy admins', async () => {
    const prisma = mockPrisma();
    const error = new Error('database unavailable');
    prisma.client.roleBinding.findMany.mockRejectedValue(error);
    await expect(new PrismaUsersRepository(prisma as never).countActiveAdmins()).rejects.toBe(error);
    expect(prisma.client.user.count).not.toHaveBeenCalled();
  });
});

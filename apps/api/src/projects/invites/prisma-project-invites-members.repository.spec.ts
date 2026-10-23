import { createMock } from '@golevelup/ts-vitest';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../generated/prisma/client';
import { PrismaProjectInvitesMembersRepository } from './prisma-project-invites-members.repository';

describe('PrismaProjectInvitesMembersRepository account creation', () => {
  it('writes only account data and returns a role-free domain account', async () => {
    const input = { email: 'invited@example.com', name: 'Invited', passwordHash: 'hash' };
    const create = vi.fn().mockResolvedValue({
      ...input, id: 'u1', role: 'ADMIN', disabled: false, tokenVersion: 0,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const prisma = createMock<PrismaService<PrismaClient>>({
      client: createMock<PrismaClient>({ user: { create } } as Partial<PrismaClient>),
    });
    const repo = new PrismaProjectInvitesMembersRepository(prisma);
    const user = await repo.createInvitedUser(input);
    expect(create).toHaveBeenCalledExactlyOnceWith({ data: input });
    expect(user).toMatchObject({ ...input, id: 'u1' });
    expect(user).not.toHaveProperty('role');
  });
});

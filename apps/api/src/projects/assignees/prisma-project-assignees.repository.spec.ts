import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../generated/prisma/client';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import { PrismaProjectAssigneesRepository } from './prisma-project-assignees.repository';

const transactionManager = {
  run: <T>(fn: () => Promise<T>) => fn(),
  getClient: () => ({}),
  isInTransaction: () => false,
} as unknown as ITransactionManager;

const repositoryWith = (members: unknown[], roster: unknown[]) => {
  const memberFindMany = jest.fn().mockResolvedValue(members);
  const rosterFindMany = jest.fn().mockResolvedValue(roster);
  const prisma = {
    client: {
      projectMember: { findMany: memberFindMany },
      agentProject: { findMany: rosterFindMany },
    },
  };
  return {
    repository: new PrismaProjectAssigneesRepository(transactionManager, prisma as unknown as PrismaService<PrismaClient>),
    memberFindMany,
    rosterFindMany,
  };
};

describe('PrismaProjectAssigneesRepository.search', () => {
  it('reads non-disabled project members only', async () => {
    const { repository, memberFindMany } = repositoryWith(
      [{ userId: 'u1', user: { name: 'Alice', email: 'alice@koda.test' } }],
      [],
    );

    const items = await repository.search('proj-1', '', 20);

    expect(memberFindMany.mock.calls[0][0].where).toEqual({
      projectId: 'proj-1',
      user: { disabled: false },
    });
    expect(memberFindMany.mock.calls[0][0].take).toBe(20);
    expect(items).toEqual([{ type: 'user', id: 'u1', name: 'Alice', secondary: 'alice@koda.test' }]);
  });

  it('falls back to the email when a member has no name', async () => {
    const { repository } = repositoryWith(
      [{ userId: 'u1', user: { name: null, email: 'alice@koda.test' } }],
      [],
    );

    const [user] = await repository.search('proj-1', '', 20);

    expect(user.name).toBe('alice@koda.test');
  });

  it('offers only rostered ACTIVE or PAUSED agents, carrying the status', async () => {
    const { repository, rosterFindMany } = repositoryWith(
      [],
      [{ agentId: 'a1', agent: { name: 'alias-bot', slug: 'alias-bot', status: 'PAUSED' } }],
    );

    const items = await repository.search('proj-1', '', 20);

    expect(rosterFindMany.mock.calls[0][0].where).toEqual({
      projectId: 'proj-1',
      agent: { status: { in: ['ACTIVE', 'PAUSED'] } },
    });
    expect(items).toEqual([
      { type: 'agent', id: 'a1', name: 'alias-bot', secondary: 'alias-bot', status: 'PAUSED' },
    ]);
  });

  it('matches q case-insensitively on name or email (users) and name or slug (agents)', async () => {
    const { repository, memberFindMany, rosterFindMany } = repositoryWith([], []);

    await repository.search('proj-1', 'ALI', 20);

    expect(memberFindMany.mock.calls[0][0].where.user).toEqual({
      disabled: false,
      OR: [
        { name: { contains: 'ALI', mode: 'insensitive' } },
        { email: { contains: 'ALI', mode: 'insensitive' } },
      ],
    });
    expect(rosterFindMany.mock.calls[0][0].where.agent).toEqual({
      status: { in: ['ACTIVE', 'PAUSED'] },
      OR: [
        { name: { contains: 'ALI', mode: 'insensitive' } },
        { slug: { contains: 'ALI', mode: 'insensitive' } },
      ],
    });
  });

  it('adds no name filter for an empty q', async () => {
    const { repository, memberFindMany, rosterFindMany } = repositoryWith([], []);

    await repository.search('proj-1', '', 20);

    expect(memberFindMany.mock.calls[0][0].where.user.OR).toBeUndefined();
    expect(rosterFindMany.mock.calls[0][0].where.agent.OR).toBeUndefined();
  });

  it('puts every user before every agent and caps the combined list at limit', async () => {
    const { repository } = repositoryWith(
      [{ userId: 'u1', user: { name: 'Alice', email: 'alice@koda.test' } }],
      [{ agentId: 'a1', agent: { name: 'a-bot', slug: 'a-bot', status: 'ACTIVE' } }],
    );

    const items = await repository.search('proj-1', '', 2);

    expect(items.map((item) => item.type)).toEqual(['user', 'agent']);

    const capped = await repository.search('proj-1', '', 1);
    expect(capped).toHaveLength(1);
    expect(capped[0].type).toBe('user');
  });

  it('orders each group by name', async () => {
    const { repository, memberFindMany, rosterFindMany } = repositoryWith([], []);

    await repository.search('proj-1', '', 20);

    expect(memberFindMany.mock.calls[0][0].orderBy).toEqual([{ user: { name: 'asc' } }, { userId: 'asc' }]);
    expect(rosterFindMany.mock.calls[0][0].orderBy).toEqual([{ agent: { name: 'asc' } }, { agentId: 'asc' }]);
  });
});

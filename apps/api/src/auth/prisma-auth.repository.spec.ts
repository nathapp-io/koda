import { createMock } from '@golevelup/ts-jest';
import { ITransactionManager } from '@nathapp/nestjs-data';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaAuthRepository } from './prisma-auth.repository';

describe('PrismaAuthRepository agent methods', () => {
  const mockAgent = { id: 'a1', slug: 'bot', status: 'ACTIVE', apiKeyHash: 'hash123' };
  const prisma = createMock<PrismaService>({
    client: {
      agent: { findFirst: jest.fn().mockResolvedValue(mockAgent) },
      agentRoleEntry: { findMany: jest.fn().mockResolvedValue([{ role: 'DEVELOPER' }]) },
      agentCapabilityEntry: { findMany: jest.fn().mockResolvedValue([{ capability: 'read:tickets' }]) },
    } as any,
  });

  const txManager = createMock<ITransactionManager>({
    run: <T>(fn: () => Promise<T>) => fn(),
  });

  const repo = new PrismaAuthRepository(prisma as any, txManager);

  it('findAgentByKeyHash returns AgentDomain', async () => {
    const result = await repo.findAgentByKeyHash('hash123');
    expect(result).toEqual({ id: 'a1', slug: 'bot', status: 'ACTIVE', apiKeyHash: 'hash123' });
  });

  it('findAgentRoles returns role strings', async () => {
    expect(await repo.findAgentRoles('a1')).toEqual(['DEVELOPER']);
  });

  it('findAgentCapabilities returns capability strings', async () => {
    expect(await repo.findAgentCapabilities('a1')).toEqual(['read:tickets']);
  });
});

describe('PrismaAuthRepository.findAnyUserAndCreate bootstrap race', () => {
  const txManager = createMock<ITransactionManager>({ run: <T>(fn: () => Promise<T>) => fn() });

  const makePrisma = (): {
    prisma: PrismaService;
    findFirst: jest.Mock;
    create: jest.Mock;
    queryRaw: jest.Mock;
  } => {
    const findFirst = jest.fn();
    const create = jest.fn();
    const queryRaw = jest.fn().mockResolvedValue([{ locked: 1 }]);
    const prisma = createMock<PrismaService>({
      client: {
        $queryRaw: queryRaw,
        user: {
          findFirst,
          create,
        },
      } as any,
    });
    return { prisma, findFirst, create, queryRaw };
  };

  it('assigns ADMIN and reports firstUser=true when no user exists', async () => {
    const { prisma, findFirst, create } = makePrisma();
    findFirst.mockResolvedValueOnce(null);
    create.mockResolvedValueOnce({
      id: 'u1', email: 'a@example.com', name: 'A', passwordHash: 'h',
      role: 'ADMIN', tokenVersion: 0, createdAt: new Date(), updatedAt: new Date(),
    });
    const txManager = createMock<ITransactionManager>({ run: <T>(fn: () => Promise<T>) => fn() });
    const repo = new PrismaAuthRepository(prisma as any, txManager);

    const result = await repo.findAnyUserAndCreate({
      email: 'a@example.com',
      name: 'A',
      passwordHash: 'h',
    }, { allowWhenUsersExist: true });

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: 'ADMIN' }) }),
    );
    expect(result.firstUser).toBe(true);
    expect(result.user.role).toBe('ADMIN');
  });

  it('does not pass role and reports firstUser=false when a user already exists', async () => {
    const { prisma, findFirst, create } = makePrisma();
    findFirst.mockResolvedValueOnce({ id: 'existing' });
    create.mockResolvedValueOnce({
      id: 'u2', email: 'b@example.com', name: 'B', passwordHash: 'h',
      role: 'MEMBER', tokenVersion: 0, createdAt: new Date(), updatedAt: new Date(),
    });
    const txManager = createMock<ITransactionManager>({ run: <T>(fn: () => Promise<T>) => fn() });
    const repo = new PrismaAuthRepository(prisma as any, txManager);

    const result = await repo.findAnyUserAndCreate({
      email: 'b@example.com',
      name: 'B',
      passwordHash: 'h',
    }, { allowWhenUsersExist: true });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.not.objectContaining({ role: expect.anything() }) }),
    );
    expect(result.firstUser).toBe(false);
    expect(result.user.role).toBe('MEMBER');
  });

  it('runs the existence-check and create inside the same transaction', async () => {
    const { prisma, findFirst, create } = makePrisma();
    findFirst.mockResolvedValueOnce(null);
    create.mockResolvedValueOnce({
      id: 'u3', email: 'c@example.com', name: 'C', passwordHash: 'h',
      role: 'ADMIN', tokenVersion: 0, createdAt: new Date(), updatedAt: new Date(),
    });
    const run = jest.fn(<T>(fn: () => Promise<T>) => fn());
    const txManager = createMock<ITransactionManager>({ run });
    const repo = new PrismaAuthRepository(prisma as any, txManager);

    await repo.findAnyUserAndCreate({
      email: 'c@example.com',
      name: 'C',
      passwordHash: 'h',
    }, { allowWhenUsersExist: true });

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('returns null without creating when users exist and registration is closed', async () => {
    const { prisma, findFirst, create } = makePrisma();
    findFirst.mockResolvedValueOnce({ id: 'existing' });
    const repo = new PrismaAuthRepository(prisma as any, txManager);

    const result = await repo.findAnyUserAndCreate(
      { email: 'b@example.com', name: 'B', passwordHash: 'h' },
      { allowWhenUsersExist: false },
    );

    expect(result).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('bootstraps on an empty table even when registration is closed', async () => {
    const { prisma, findFirst, create } = makePrisma();
    findFirst.mockResolvedValueOnce(null);
    create.mockResolvedValueOnce({
      id: 'u1', email: 'a@example.com', name: 'A', passwordHash: 'h', role: 'ADMIN',
      tokenVersion: 0, createdAt: new Date(), updatedAt: new Date(),
    });
    const repo = new PrismaAuthRepository(prisma as any, txManager);

    const result = await repo.findAnyUserAndCreate(
      { email: 'a@example.com', name: 'A', passwordHash: 'h' },
      { allowWhenUsersExist: false },
    );

    expect(result?.firstUser).toBe(true);
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ role: 'ADMIN' }) });
  });

  it('takes the bootstrap lock before the existence check', async () => {
    const { prisma, findFirst, queryRaw } = makePrisma();
    findFirst.mockResolvedValueOnce({ id: 'existing' });
    const repo = new PrismaAuthRepository(prisma as any, txManager);

    await repo.findAnyUserAndCreate({ email: 'c@example.com', name: 'C', passwordHash: 'h' }, { allowWhenUsersExist: false });

    expect(queryRaw).toHaveBeenCalled();
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(findFirst.mock.invocationCallOrder[0]);
  });
});

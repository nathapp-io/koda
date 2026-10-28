import type { Mock } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { ITransactionManager } from '@nathapp/nestjs-data';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaAuthRepository } from './prisma-auth.repository';

describe('PrismaAuthRepository agent methods', () => {
  const mockAgent = { id: 'a1', slug: 'bot', status: 'ACTIVE', apiKeyHash: 'hash123' };
  const prisma = createMock<PrismaService>({
    client: {
      agent: { findFirst: vi.fn().mockResolvedValue(mockAgent) },
      agentCapabilityEntry: { findMany: vi.fn().mockResolvedValue([{ capability: 'read:tickets' }]) },
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

  it('findAgentCapabilities returns capability strings', async () => {
    expect(await repo.findAgentCapabilities('a1')).toEqual(['read:tickets']);
  });

  it('findAgentById selects the actor fields by id', async () => {
    const findUnique = vi.fn().mockResolvedValue(mockAgent);
    const db = createMock<PrismaService>({ client: { agent: { findUnique } } as any });
    const repository = new PrismaAuthRepository(db as any, txManager);
    await expect(repository.findAgentById('a1')).resolves.toEqual(mockAgent);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'a1' }, select: { id: true, slug: true, status: true, apiKeyHash: true },
    });
  });

  it('hasGlobalAdminBinding counts only global user owner/admin bindings', async () => {
    const count = vi.fn().mockResolvedValue(1);
    const db = createMock<PrismaService>({ client: { roleBinding: { count } } as any });
    const repository = new PrismaAuthRepository(db as any, txManager);
    await expect(repository.hasGlobalAdminBinding('u1')).resolves.toBe(true);
    expect(count).toHaveBeenCalledWith({ where: {
      principalType: 'USER', principalId: 'u1', projectId: null,
      role: { key: { in: ['owner', 'admin'] } },
    } });
  });
});

describe('PrismaAuthRepository.findAnyUserAndCreate bootstrap race', () => {
  const txManager = createMock<ITransactionManager>({ run: <T>(fn: () => Promise<T>) => fn() });

  const makePrisma = (): {
    prisma: PrismaService;
    findFirst: Mock;
    create: Mock;
    queryRaw: Mock;
  } => {
    const findFirst = vi.fn();
    const create = vi.fn();
    const queryRaw = vi.fn().mockResolvedValue([{ locked: 1 }]);
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

  it('AC-13: writes only given data and reports firstUser=true when no user exists', async () => {
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
      { data: { email: 'a@example.com', name: 'A', passwordHash: 'h' } },
    );
    expect(result.firstUser).toBe(true);
    expect(result.user).not.toHaveProperty('role');
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
    expect(result.user).not.toHaveProperty('role');
  });

  it('runs the existence-check and create inside the same transaction', async () => {
    const { prisma, findFirst, create } = makePrisma();
    findFirst.mockResolvedValueOnce(null);
    create.mockResolvedValueOnce({
      id: 'u3', email: 'c@example.com', name: 'C', passwordHash: 'h',
      role: 'ADMIN', tokenVersion: 0, createdAt: new Date(), updatedAt: new Date(),
    });
    const run = vi.fn(<T>(fn: () => Promise<T>) => fn());
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
    expect(create).toHaveBeenCalledWith({ data: { email: 'a@example.com', name: 'A', passwordHash: 'h' } });
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

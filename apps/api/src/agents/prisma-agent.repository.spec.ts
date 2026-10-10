import type { Mock } from 'vitest';
/**
 * US-003 — PrismaAgentRepository.createRolesAndCapabilities must write the role
 * and capability rows with sequential `createMany` calls on the ambient client
 * (the transaction the caller opened with `txManager.run`), never with a nested
 * `$transaction([...])` — a nested transaction cannot be rolled back by the
 * caller's transaction manager.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService, createMockPrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaAgentRepository } from './prisma-agent.repository';

type MockPrismaService = ReturnType<typeof createMockPrismaService>;

describe('PrismaAgentRepository.createRolesAndCapabilities (US-003)', () => {
  let testingModule: TestingModule;
  let repository: PrismaAgentRepository;
  let prisma: MockPrismaService;
  let roleCreateMany: Mock;
  let capabilityCreateMany: Mock;

  beforeEach(async () => {
    prisma = createMockPrismaService({ fn: vi.fn });

    roleCreateMany = vi.fn().mockResolvedValue({ count: 2 });
    capabilityCreateMany = vi.fn().mockResolvedValue({ count: 1 });

    prisma.client.agentRoleEntry = { createMany: roleCreateMany };
    prisma.client.agentCapabilityEntry = { createMany: capabilityCreateMany };

    // Prisma's array form: run the promises and settle them, so a rejected write
    // is handled here rather than becoming an unhandled rejection.
    (prisma.client.$transaction as Mock).mockImplementation(
      async (arg: unknown) =>
        Array.isArray(arg) ? Promise.all(arg) : (arg as () => Promise<unknown>)(),
    );

    testingModule = await Test.createTestingModule({
      providers: [
        PrismaAgentRepository,
        { provide: PrismaService, useValue: prisma },
        {
          provide: TRANSACTION_MANAGER,
          useValue: {
            run: vi.fn((fn: () => Promise<unknown>) => fn()),
            getClient: vi.fn(),
            isInTransaction: vi.fn(() => false),
          },
        },
      ],
    }).compile();

    repository = testingModule.get(PrismaAgentRepository);
  });

  afterEach(async () => {
    await testingModule.close();
    vi.clearAllMocks();
  });

  it('AC8: issues one agentRoleEntry.createMany and one agentCapabilityEntry.createMany on the ambient client', async () => {
    await repository.createRolesAndCapabilities(
      'agent-1',
      ['DEVELOPER', 'REVIEWER'],
      ['typescript'],
    );

    expect(roleCreateMany).toHaveBeenCalledTimes(1);
    expect(roleCreateMany.mock.calls[0][0].data).toEqual([
      { agentId: 'agent-1', role: 'DEVELOPER' },
      { agentId: 'agent-1', role: 'REVIEWER' },
    ]);

    expect(capabilityCreateMany).toHaveBeenCalledTimes(1);
    expect(capabilityCreateMany.mock.calls[0][0].data).toEqual([
      { agentId: 'agent-1', capability: 'typescript' },
    ]);
  });

  it('AC8: never calls $transaction', async () => {
    await repository.createRolesAndCapabilities('agent-1', ['DEVELOPER'], ['typescript']);

    expect(prisma.client.$transaction).not.toHaveBeenCalled();
  });

  it('AC8 boundary: writes roles before capabilities (sequential, not batched)', async () => {
    await repository.createRolesAndCapabilities('agent-1', ['DEVELOPER'], ['typescript']);

    expect(roleCreateMany.mock.invocationCallOrder[0]).toBeLessThan(
      capabilityCreateMany.mock.invocationCallOrder[0],
    );
  });

  it('AC8 boundary: empty role and capability lists still avoid $transaction', async () => {
    await repository.createRolesAndCapabilities('agent-1', [], []);

    expect(prisma.client.$transaction).not.toHaveBeenCalled();
  });

  it('AC8 boundary: a rejecting capability write surfaces instead of being swallowed', async () => {
    const failure = new Error('agentCapabilityEntry insert failed');
    capabilityCreateMany.mockRejectedValue(failure);

    await expect(
      repository.createRolesAndCapabilities('agent-1', ['DEVELOPER'], ['typescript']),
    ).rejects.toBe(failure);

    expect(prisma.client.$transaction).not.toHaveBeenCalled();
  });
});

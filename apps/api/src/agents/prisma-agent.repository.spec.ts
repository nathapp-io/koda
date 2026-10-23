import type { Mock } from 'vitest';
/**
 * Permissions P1l (US-005) — PrismaAgentRepository.createCapabilities writes the agent's capability
 * rows on the ambient client (the transaction the caller opened with `txManager.run`), never with a
 * nested `$transaction([...])` — a nested transaction cannot be rolled back by the caller's
 * transaction manager.
 *
 * The role-write half is gone: an agent's roles are role bindings now, so creation must touch no
 * `AgentRoleEntry` row at all.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService, createMockPrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaAgentRepository } from './prisma-agent.repository';

type MockPrismaService = ReturnType<typeof createMockPrismaService>;

describe('PrismaAgentRepository.createCapabilities (US-005)', () => {
  let testingModule: TestingModule;
  let repository: PrismaAgentRepository;
  let prisma: MockPrismaService;
  let roleCreateMany: Mock;
  let capabilityCreateMany: Mock;

  beforeEach(async () => {
    prisma = createMockPrismaService({ fn: vi.fn });

    roleCreateMany = vi.fn().mockResolvedValue({ count: 1 });
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

  it('AC-10: issues one agentCapabilityEntry.createMany on the ambient client and no role write', async () => {
    await repository.createCapabilities('agent-1', ['nax', 'typescript']);

    expect(capabilityCreateMany).toHaveBeenCalledTimes(1);
    expect(capabilityCreateMany.mock.calls[0][0].data).toEqual([
      { agentId: 'agent-1', capability: 'nax' },
      { agentId: 'agent-1', capability: 'typescript' },
    ]);
    expect(roleCreateMany).not.toHaveBeenCalled();
  });

  it('never calls $transaction', async () => {
    await repository.createCapabilities('agent-1', ['typescript']);

    expect(prisma.client.$transaction).not.toHaveBeenCalled();
  });

  it('boundary: an empty capability list writes nothing and still avoids $transaction', async () => {
    await repository.createCapabilities('agent-1', []);

    expect(capabilityCreateMany).not.toHaveBeenCalled();
    expect(roleCreateMany).not.toHaveBeenCalled();
    expect(prisma.client.$transaction).not.toHaveBeenCalled();
  });

  it('boundary: a rejecting capability write surfaces instead of being swallowed', async () => {
    const failure = new Error('agentCapabilityEntry insert failed');
    capabilityCreateMany.mockRejectedValue(failure);

    await expect(repository.createCapabilities('agent-1', ['typescript'])).rejects.toBe(failure);

    expect(prisma.client.$transaction).not.toHaveBeenCalled();
  });
});

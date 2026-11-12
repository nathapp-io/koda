import { createMockPrismaService, PrismaService } from '@nathapp/nestjs-prisma';
import { Test, TestingModule } from '@nestjs/testing';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaAgentRepository } from './prisma-agent.repository';

type MockPrisma = ReturnType<typeof createMockPrismaService>;

describe('PrismaAgentRepository.findProjectRoster agent id', () => {
  let module: TestingModule;
  let repository: PrismaAgentRepository;
  let prisma: MockPrisma;
  const memberships = [{ principalId: 'agent-1', since: new Date('2026-01-01T00:00:00Z'), addedByUserId: null }];

  beforeEach(async () => {
    prisma = createMockPrismaService({ fn: vi.fn });
    prisma.client.roleBinding = { findMany: vi.fn().mockResolvedValue(memberships.map((row) => ({
      principalId: row.principalId, createdAt: row.since, grantedByType: 'SYSTEM', grantedById: 'system', role: { key: 'viewer' },
    }))) };
    prisma.client.agent = { findMany: vi.fn().mockResolvedValue([{
      id: 'agent-1', slug: 'bot', name: 'Probe Bot', status: 'ACTIVE', capabilities: [],
    }]) };
    prisma.client.user = { findMany: vi.fn().mockResolvedValue([]) };
    prisma.client.ticket = { findMany: vi.fn().mockResolvedValue([]) };
    prisma.client.project = { findUnique: vi.fn().mockResolvedValue({ key: 'PROJ' }) };
    module = await Test.createTestingModule({ providers: [
      PrismaAgentRepository,
      { provide: PrismaService, useValue: prisma },
      { provide: TRANSACTION_MANAGER, useValue: { run: vi.fn((fn: () => Promise<unknown>) => fn()), getClient: vi.fn(), isInTransaction: vi.fn(() => false) } },
    ] }).compile();
    repository = module.get(PrismaAgentRepository);
  });

  afterEach(async () => { await module.close(); vi.clearAllMocks(); });

  it('US-001 AC-2: returns the Agent row id independently of its slug', async () => {
    const [record] = await repository.findProjectRoster('proj-1');
    expect(record).toMatchObject({ id: 'agent-1', slug: 'bot' });
  });

  it('US-001 AC-4: preserves the empty-roster fast path', async () => {
    prisma.client.roleBinding = { findMany: vi.fn().mockResolvedValue([]) };
    await expect(repository.findProjectRoster('proj-1')).resolves.toEqual([]);
  });
});

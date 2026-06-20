import { createMock } from '@golevelup/ts-jest';
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

  const repo = new PrismaAuthRepository(prisma as any);

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

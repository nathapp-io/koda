import { PrismaFleetPrRulingRepository } from './prisma-fleet-pr-ruling.repository';

describe('PrismaFleetPrRulingRepository.pendingForFix SYSTEM actor', () => {
  it('AC-1 maps actorId directly without user or agent lookups', async () => {
    const row = { id: 'r1', itemId: 'D-1', text: 'verified: evidence', actorType: 'SYSTEM', actorId: 'flow', createdAt: new Date() };
    const prisma = { client: {
      fleetPrRuling: { findMany: vi.fn().mockResolvedValue([row]) },
      agent: { findMany: vi.fn().mockResolvedValue([]) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    } };
    const repository = new PrismaFleetPrRulingRepository({} as never, prisma as never);
    const result = await repository.pendingForFix('run');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ actorType: 'SYSTEM', actorId: 'flow', actorName: 'flow' });
    expect(prisma.client.agent.findMany).not.toHaveBeenCalled();
    expect(prisma.client.user.findMany).not.toHaveBeenCalled();
  });
});

import { CacheManager } from '@nathapp/nestjs-cache';
import { AgentAuthProvider } from './agent-auth.provider';
import { PrismaAuthRepository } from './prisma-auth.repository';

describe('AgentAuthProvider binding-only principal', () => {
  it.each(['ACTIVE', 'PAUSED'])('AC-7: loads capabilities but no legacy roles (%s)', async (status) => {
    const findAgentCapabilities = vi.fn().mockResolvedValue(['nax']);
    const get = vi.fn((_key: unknown, loader: () => Promise<unknown>) => loader());
    const provider = new AgentAuthProvider(
      { findAgentCapabilities } as unknown as PrismaAuthRepository,
      { get } as unknown as CacheManager,
    );
    const principal = await provider.buildPrincipal({ id: 'a1', slug: 'bot', status, apiKeyHash: 'hash' });
    expect(principal.capabilities).toEqual(['nax']);
    expect(principal.authorities).toEqual([]);
    expect(principal).not.toHaveProperty('agentRoles');
    expect(principal.blacklisted).toBe(status === 'PAUSED');
    expect(principal.revoked).toBe(false);
    expect(findAgentCapabilities).toHaveBeenCalledWith('a1');
    expect(get).toHaveBeenCalledWith(['agent-principal', 'a1', status], expect.any(Function), 60_000,
      { tags: ['AGENT:a1', 'AGENT:a1:PRINCIPAL'] });
  });
});

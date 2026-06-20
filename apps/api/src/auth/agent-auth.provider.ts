import { Injectable } from '@nestjs/common';
import { CacheManager } from '@nathapp/nestjs-cache';
import { AgentPrincipal, KodaAgentRole, KodaAgentStatus } from './principal/koda-principal.types';
import { PrismaAuthRepository } from './prisma-auth.repository';
import type { AgentDomain } from './domain/auth.domain';

@Injectable()
export class AgentAuthProvider {
  constructor(
    private readonly authRepo: PrismaAuthRepository,
    private readonly cache: CacheManager,
  ) {}

  async buildPrincipal(agent: AgentDomain): Promise<AgentPrincipal> {
    return this.cache.get<AgentPrincipal>(
      ['agent-principal', agent.id, agent.status],
      async () => {
        const [agentRoles, capabilities] = await Promise.all([
          this.loadAgentRoles(agent.id),
          this.loadAgentCapabilities(agent.id),
        ]);

        return {
          actorType: 'agent',
          id: agent.id,
          name: agent.slug,
          slug: agent.slug,
          status: agent.status as KodaAgentStatus,
          agentRoles,
          capabilities,
          blacklisted: agent.status === 'PAUSED',
          revoked: false,
          authorities: agentRoles,
          extra: {
            slug: agent.slug,
          },
        };
      },
      60_000,
      {
        tags: [`AGENT:${agent.id}`, `AGENT:${agent.id}:PRINCIPAL`],
      },
    );
  }

  async loadAgentRoles(agentId: string): Promise<KodaAgentRole[]> {
    const roles = await this.authRepo.findAgentRoles(agentId);
    return roles as KodaAgentRole[];
  }

  async loadAgentCapabilities(agentId: string): Promise<string[]> {
    return this.authRepo.findAgentCapabilities(agentId);
  }

  async invalidateByTag(tag: string): Promise<void> {
    await this.cache.invalidate(tag, { mode: 'tag' });
  }
}

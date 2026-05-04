import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { CacheManager } from '../cache/cache.module';
import type { Agent, PrismaClient } from '@prisma/client';
import { AgentPrincipal, KodaAgentRole, KodaAgentStatus } from './principal/koda-principal.types';

@Injectable()
export class AgentAuthProvider {
  constructor(
    private readonly prisma: PrismaService<PrismaClient>,
    private readonly cache: CacheManager,
  ) {}

  async buildPrincipal(agent: Agent): Promise<AgentPrincipal> {
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
    const roles = await this.prisma.client.agentRoleEntry.findMany({
      where: { agentId },
      select: { role: true },
    });
    return roles.map((entry) => entry.role as KodaAgentRole);
  }

  async loadAgentCapabilities(agentId: string): Promise<string[]> {
    const capabilities = await this.prisma.client.agentCapabilityEntry.findMany({
      where: { agentId },
      select: { capability: true },
    });
    return capabilities.map((entry) => entry.capability);
  }

  async invalidateByTag(tag: string): Promise<void> {
    await this.cache.invalidate(tag, { mode: 'tag' });
  }
}

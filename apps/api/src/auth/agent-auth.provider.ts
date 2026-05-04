import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { Agent, PrismaClient } from '@prisma/client';
import { AgentPrincipal, KodaAgentRole, KodaAgentStatus } from './principal/koda-principal.types';

interface CacheEntry {
  principal: AgentPrincipal;
  expiresAt: number;
  tags: string[];
}

@Injectable()
export class AgentAuthProvider {
  private readonly ttlMs = 60_000;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly tagIndex = new Map<string, Set<string>>();

  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async buildPrincipal(agent: Agent): Promise<AgentPrincipal> {
    const key = this.buildCacheKey(agent.id, agent.status);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.principal;
    }

    const [agentRoles, capabilities] = await Promise.all([
      this.loadAgentRoles(agent.id),
      this.loadAgentCapabilities(agent.id),
    ]);

    const principal: AgentPrincipal = {
      actorType: 'agent',
      id: agent.id,
      name: agent.slug,
      slug: agent.slug,
      status: agent.status as KodaAgentStatus,
      agentRoles,
      capabilities,
      blacklisted: agent.status === 'OFFLINE',
      revoked: false,
      authorities: agentRoles,
      extra: {
        slug: agent.slug,
      },
    };

    this.setCache(key, principal, [`AGENT:${agent.id}`, `AGENT:${agent.id}:PRINCIPAL`]);

    return principal;
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

  invalidateByTag(tag: string): void {
    const keys = this.tagIndex.get(tag);
    if (!keys) {
      return;
    }

    for (const key of keys) {
      const existing = this.cache.get(key);
      if (existing) {
        for (const existingTag of existing.tags) {
          const set = this.tagIndex.get(existingTag);
          set?.delete(key);
          if (set && set.size === 0) {
            this.tagIndex.delete(existingTag);
          }
        }
      }
      this.cache.delete(key);
    }
    this.tagIndex.delete(tag);
  }

  private setCache(key: string, principal: AgentPrincipal, tags: string[]): void {
    this.cache.set(key, {
      principal,
      expiresAt: Date.now() + this.ttlMs,
      tags,
    });
    for (const tag of tags) {
      const keys = this.tagIndex.get(tag) ?? new Set<string>();
      keys.add(key);
      this.tagIndex.set(tag, keys);
    }
  }

  private buildCacheKey(agentId: string, status: string): string {
    return `agent-principal:${agentId}:${status}`;
  }
}

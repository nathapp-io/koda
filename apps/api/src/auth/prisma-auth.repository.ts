import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { AgentDomain, UserDomain } from './domain/auth.domain';

@Injectable()
export class PrismaAuthRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toDomain(m: any): UserDomain {
    return {
      id: m.id,
      email: m.email,
      name: m.name,
      role: m.role,
      passwordHash: m.passwordHash,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  }

  async findAnyUser(): Promise<{ id: string } | null> {
    return this.db.user.findFirst({ select: { id: true } });
  }

  async createUser(data: {
    email: string;
    name: string;
    passwordHash: string;
    role?: string;
  }): Promise<UserDomain> {
    const m = await this.db.user.create({ data });
    return this.toDomain(m);
  }

  async findUserByEmail(email: string): Promise<UserDomain | null> {
    const m = await this.db.user.findUnique({ where: { email } });
    return m ? this.toDomain(m) : null;
  }

  async findUserById(id: string): Promise<UserDomain | null> {
    const m = await this.db.user.findUnique({ where: { id } });
    return m ? this.toDomain(m) : null;
  }

  async findAgentByKeyHash(keyHash: string): Promise<AgentDomain | null> {
    const m = await this.db.agent.findFirst({ where: { apiKeyHash: keyHash } });
    if (!m) return null;
    return { id: m.id, slug: m.slug, status: m.status, apiKeyHash: m.apiKeyHash };
  }

  async findAgentRoles(agentId: string): Promise<string[]> {
    const rows = await this.db.agentRoleEntry.findMany({ where: { agentId }, select: { role: true } });
    return rows.map((r) => r.role);
  }

  async findAgentCapabilities(agentId: string): Promise<string[]> {
    const rows = await this.db.agentCapabilityEntry.findMany({ where: { agentId }, select: { capability: true } });
    return rows.map((r) => r.capability);
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { AgentDomain, UserDomain } from './domain/auth.domain';

@Injectable()
export class PrismaAuthRepository {
  constructor(
    private readonly prisma: PrismaService<PrismaClient>,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

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
      tokenVersion: m.tokenVersion,
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

  /**
   * Atomically checks if any user exists and creates a new user, optionally
   * with the bootstrap ADMIN role. Serializing the existence-check and the
   * create inside a single transaction prevents two concurrent registrations
   * against an empty database from both becoming ADMIN.
   */
  async findAnyUserAndCreate(data: {
    email: string;
    name: string;
    passwordHash: string;
  }): Promise<{ user: UserDomain; firstUser: boolean }> {
    return this.txManager.run(async () => {
      const existing = await this.db.user.findFirst({ select: { id: true } });
      const firstUser = existing === null;
      const m = await this.db.user.create({
        data: firstUser
          ? { ...data, role: 'ADMIN' }
          : data,
      });
      return { user: this.toDomain(m), firstUser };
    });
  }

  async findUserByEmail(email: string): Promise<UserDomain | null> {
    const m = await this.db.user.findUnique({ where: { email } });
    return m ? this.toDomain(m) : null;
  }

  async findUserById(id: string): Promise<UserDomain | null> {
    const m = await this.db.user.findUnique({ where: { id } });
    return m ? this.toDomain(m) : null;
  }

  async bumpTokenVersion(userId: string): Promise<number> {
    const m = await this.db.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
      select: { tokenVersion: true },
    });
    return m.tokenVersion;
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
    return rows.map((c) => c.capability);
  }
}

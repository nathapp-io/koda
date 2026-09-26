import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { AgentDomain, UserDomain } from './domain/auth.domain';
import { GlobalLock, lockGlobal } from '../common/utils/advisory-lock';

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
      disabled: m.disabled,
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
   * Bootstrap-safe user creation. A transaction-scoped advisory lock taken
   * before the existence check serializes concurrent registrations, so on an
   * empty table exactly one caller becomes ADMIN (Postgres has no SQLite-style
   * write serialization). Returns null and writes nothing when users already
   * exist and `allowWhenUsersExist` is false (registration closed).
   */
  async findAnyUserAndCreate(
    data: { email: string; name: string; passwordHash: string },
    options: { allowWhenUsersExist: boolean },
  ): Promise<{ user: UserDomain; firstUser: boolean } | null> {
    return this.txManager.run(async () => {
      await lockGlobal(this.db, GlobalLock.USER_BOOTSTRAP);
      const existing = await this.db.user.findFirst({ select: { id: true } });
      const firstUser = existing === null;
      if (!firstUser && !options.allowWhenUsersExist) return null;
      const m = await this.db.user.create({
        data: firstUser ? { ...data, role: 'ADMIN' } : data,
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

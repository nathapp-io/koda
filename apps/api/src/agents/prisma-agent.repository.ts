import { Injectable } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';

@Injectable()
export class PrismaAgentRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  async findAll() {
    return this.db.agent.findMany({
      include: { roles: true, capabilities: true },
    });
  }

  async findBySlug(slug: string) {
    return this.db.agent.findUnique({
      where: { slug },
      include: { roles: true, capabilities: true },
    });
  }

  async findById(id: string) {
    return this.db.agent.findUnique({
      where: { id },
      include: { roles: true, capabilities: true },
    });
  }

  async findBySlugWithCapabilities(slug: string) {
    return this.db.agent.findUnique({
      where: { slug },
      include: { capabilities: true },
    });
  }

  async findBySlugScalar(slug: string) {
    return this.db.agent.findUnique({ where: { slug } });
  }

  async findByIdScalar(id: string) {
    return this.db.agent.findUnique({ where: { id } });
  }

  async create(data: {
    name: string;
    slug: string;
    apiKeyHash: string;
    maxConcurrentTickets?: number;
  }) {
    return this.db.agent.create({ data });
  }

  async updateApiKeyHash(id: string, apiKeyHash: string) {
    return this.db.agent.update({
      where: { id },
      data: { apiKeyHash },
      include: { roles: true, capabilities: true },
    });
  }

  async update(slug: string, data: Partial<{ name: string; status: string; maxConcurrentTickets: number }>) {
    return this.db.agent.update({
      where: { slug },
      data,
      include: { roles: true, capabilities: true },
    });
  }

  async deleteBySlug(slug: string) {
    return this.db.agent.delete({ where: { slug } });
  }

  /**
   * US-003: writes roles and capabilities with sequential `createMany` calls
   * on the ambient client so a failure rolls back as part of the caller's
   * `txManager.run` — never wraps them in a nested `$transaction([...])`,
   * which the caller's transaction manager cannot roll back.
   */
  async createRolesAndCapabilities(
    agentId: string,
    roles: string[],
    capabilities: string[],
  ) {
    await this.db.agentRoleEntry.createMany({
      data: roles.map((role) => ({ agentId, role })),
    });
    await this.db.agentCapabilityEntry.createMany({
      data: capabilities.map((capability) => ({ agentId, capability })),
    });
  }

  async replaceRoles(agentId: string, roles: string[]) {
    await this.db.agentRoleEntry.deleteMany({ where: { agentId } });
    if (roles.length > 0) {
      await this.db.agentRoleEntry.createMany({
        data: roles.map((role) => ({ agentId, role })),
      });
    }
  }

  async replaceCapabilities(agentId: string, capabilities: string[]) {
    await this.db.agentCapabilityEntry.deleteMany({ where: { agentId } });
    if (capabilities.length > 0) {
      await this.db.agentCapabilityEntry.createMany({
        data: capabilities.map((capability) => ({ agentId, capability })),
      });
    }
  }

  async findProjectBySlug(slug: string) {
    return this.db.project.findUnique({ where: { slug } });
  }

  /**
   * S4c US-001: whether the agent holds an AgentProject roster row for the
   * project. The row grants project reach; it carries no role.
   */
  async isOnProjectRoster(agentId: string, projectId: string): Promise<boolean> {
    const row = await this.db.agentProject.findUnique({
      where: { agentId_projectId: { agentId, projectId } },
      select: { agentId: true },
    });
    return row !== null;
  }

  /**
   * S4c US-001: the agent's non-deleted roster projects, ordered by slug.
   * Feeds GET /agents/me; soft-deleted projects never appear.
   */
  async findRosterProjects(agentId: string): Promise<{ slug: string; name: string }[]> {
    const rows = await this.db.agentProject.findMany({
      where: { agentId, project: { deletedAt: null } },
      select: { project: { select: { slug: true, name: true } } },
      orderBy: { project: { slug: 'asc' } },
    });
    return rows.map((row) => row.project);
  }

  async findByProjectSlug(projectSlug: string) {
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
      select: { id: true, slug: true },
    });
    if (!project) return null;

    const agents = await this.db.agent.findMany({
      where: {
        assignedTickets: {
          some: {
            projectId: project.id,
            deletedAt: null,
          },
        },
      },
      include: { roles: true, capabilities: true },
    });

    return { project, agents };
  }

  async findVerifiedUnassignedTickets(projectId: string) {
    return this.db.ticket.findMany({
      where: {
        projectId,
        status: 'VERIFIED',
        assignedToAgentId: null,
        assignedToUserId: null,
        deletedAt: null,
      },
      include: {
        labels: { include: { label: true } },
      },
    });
  }
}

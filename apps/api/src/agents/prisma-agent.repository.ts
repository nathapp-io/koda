import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
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

  async createRolesAndCapabilities(
    agentId: string,
    roles: string[],
    capabilities: string[],
  ) {
    await this.db.$transaction([
      this.db.agentRoleEntry.createMany({
        data: roles.map((role) => ({ agentId, role })),
      }),
      this.db.agentCapabilityEntry.createMany({
        data: capabilities.map((capability) => ({ agentId, capability })),
      }),
    ]);
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

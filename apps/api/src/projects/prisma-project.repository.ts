import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Project, PrismaClient } from '../generated/prisma/client';
import { ProjectDomain, CreateProjectData } from './domain/project.domain';

@Injectable()
export class PrismaProjectRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private toDomain(m: Project): ProjectDomain {
    return {
      id: m.id,
      name: m.name,
      slug: m.slug,
      key: m.key,
      description: m.description,
      gitRemoteUrl: m.gitRemoteUrl,
      autoIndexOnClose: m.autoIndexOnClose,
      autoAssign: m.autoAssign,
      graphifyEnabled: m.graphifyEnabled,
      graphifyLastImportedAt: m.graphifyLastImportedAt,
      ciWebhookToken: m.ciWebhookToken,
      deletedAt: m.deletedAt,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  }

  async findBySlug(slug: string): Promise<ProjectDomain | null> {
    const model = await this.prisma.client.project.findUnique({ where: { slug } });
    return model ? this.toDomain(model) : null;
  }

  async findByKey(key: string): Promise<ProjectDomain | null> {
    const model = await this.prisma.client.project.findUnique({ where: { key } });
    return model ? this.toDomain(model) : null;
  }

  async findAll(): Promise<ProjectDomain[]> {
    const models = await this.prisma.client.project.findMany({
      where: { deletedAt: null },
    });
    return models.map((m) => this.toDomain(m));
  }

  async createProject(data: CreateProjectData): Promise<ProjectDomain> {
    const model = await this.prisma.client.project.create({ data });
    return this.toDomain(model);
  }

  async updateBySlug(
    slug: string,
    data: Partial<Omit<ProjectDomain, 'id' | 'createdAt' | 'updatedAt'>>,
  ): Promise<ProjectDomain> {
    const model = await this.prisma.client.project.update({ where: { slug }, data });
    return this.toDomain(model);
  }

  async findAllIds(): Promise<{ id: string }[]> {
    return this.prisma.client.project.findMany({ where: { deletedAt: null }, select: { id: true } });
  }

  /**
   * US-002: list every non-deleted project the given user principal is a
   * member of. Soft-deleted projects never appear, even for a member.
   */
  async findAllForUser(userId: string): Promise<ProjectDomain[]> {
    const models = await this.prisma.client.project.findMany({
      where: {
        deletedAt: null,
        members: { some: { userId } },
      },
    });
    return models.map((m) => this.toDomain(m));
  }

  async findMembershipRole(projectId: string, userId: string): Promise<string | null> {
    const m = await this.prisma.client.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { role: true },
    });
    return m?.role ?? null;
  }

  /**
   * S4c US-001: membership of the agent roster. The row carries no role — it
   * grants project reach only; permissions come from AgentRoleEntry.
   */
  async isAgentOnRoster(projectId: string, agentId: string): Promise<boolean> {
    const row = await this.prisma.client.agentProject.findUnique({
      where: { agentId_projectId: { agentId, projectId } },
      select: { agentId: true },
    });
    return row !== null;
  }

  /**
   * S4c US-001: every non-deleted project on the agent's roster, in findAll
   * order (the repository's list order).
   */
  async findAllForAgent(agentId: string): Promise<ProjectDomain[]> {
    const models = await this.prisma.client.project.findMany({
      where: {
        deletedAt: null,
        agents: { some: { agentId } },
      },
    });
    return models.map((m) => this.toDomain(m));
  }
}

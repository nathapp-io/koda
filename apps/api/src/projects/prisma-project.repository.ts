import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Project, PrismaClient } from '../generated/prisma/client';
import {
  accessibleProjectIds,
  agentHasProjectAccess,
  userProjectRole,
} from '../permissions/legacy-membership.queries';
import type { PrincipalRef } from '../permissions/permissions.types';
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
      brief: m.brief,
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
   * US-002: list every non-deleted project the given user principal may act in.
   * Soft-deleted projects never appear, even for a member.
   */
  async findAllForUser(userId: string): Promise<ProjectDomain[]> {
    return this.findAllAccessible({ type: 'USER', id: userId });
  }

  /**
   * The caller's legacy project role over its **access sources**: its legacy
   * `ProjectMember` row unioned with its PROJECT-scope bindings, in this project
   * and `projectId`-null. `null` when it has none — the same answer the legacy
   * read gave a non-member.
   */
  async findMembershipRole(projectId: string, userId: string): Promise<string | null> {
    return userProjectRole(this.prisma.client, userId, projectId);
  }

  /**
   * S4c US-001: membership of the agent roster. The row carries no role — it
   * grants project reach only; permissions come from AgentRoleEntry.
   *
   * US-002: reach comes from the agent's access sources — its `AgentProject`
   * row unioned with its project bindings (and its `projectId`-null PROJECT
   * bindings, which reach every project).
   */
  async isAgentOnRoster(projectId: string, agentId: string): Promise<boolean> {
    return agentHasProjectAccess(this.prisma.client, agentId, projectId);
  }

  /**
   * S4c US-001: every non-deleted project the agent may act in, in
   * `accessibleProjectIds` order.
   */
  async findAllForAgent(agentId: string): Promise<ProjectDomain[]> {
    return this.findAllAccessible({ type: 'AGENT', id: agentId });
  }

  /**
   * US-002: the access-source read both list methods share. The ids come from
   * the compatibility queries (legacy rows unioned with bindings; every
   * non-deleted project for a `projectId`-null PROJECT binding), and the rows
   * are then read in ascending id order.
   */
  private async findAllAccessible(principal: PrincipalRef): Promise<ProjectDomain[]> {
    const ids = await accessibleProjectIds(this.prisma.client, principal);
    const models = await this.prisma.client.project.findMany({
      where: { deletedAt: null, id: { in: ids } },
      orderBy: { id: 'asc' },
    });
    return models.map((m) => this.toDomain(m));
  }
}

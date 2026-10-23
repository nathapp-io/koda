import { Injectable } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { TicketStatus } from '../common/enums';
import { KodaError } from '../common/koda-error';
import { lockProjectAgents } from '../common/utils/advisory-lock';
import { accessibleProjectIds, agentHasProjectAccess, listProjectMemberships } from '../permissions/membership.queries';
import { MAX_OPEN_TICKET_REFS } from '../permissions/open-agent-tickets.queries';
import type { ProjectAgentRecord } from './dto/project-agent.dto';

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
   * Permissions P1l (US-005): creation writes capabilities only — an agent's roles are role bindings,
   * so no `AgentRoleEntry` row is created any more.
   *
   * US-003: writes them with one `createMany` call on the ambient client so a failure rolls back as
   * part of the caller's `txManager.run` — never wraps it in a nested `$transaction([...])`, which the
   * caller's transaction manager cannot roll back.
   */
  async createCapabilities(agentId: string, capabilities: string[]) {
    if (capabilities.length === 0) return;
    await this.db.agentCapabilityEntry.createMany({
      data: capabilities.map((capability) => ({ agentId, capability })),
    });
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

  /** Access sources include project-specific and global PROJECT bindings. */
  async isOnProjectRoster(agentId: string, projectId: string): Promise<boolean> {
    return agentHasProjectAccess(this.prisma.client, agentId, projectId);
  }

  /**
   * Serializes roster removal against ticket assignment for the project.
   * Call inside txManager.run only.
   */
  async lockProjectAgents(projectId: string): Promise<void> {
    await lockProjectAgents(this.db, projectId);
  }

  /**
   * S4c US-001: the agent's non-deleted roster projects, ordered by slug.
   * Feeds GET /agents/me; soft-deleted projects never appear.
   */
  async findRosterProjects(agentId: string): Promise<{ slug: string; name: string }[]> {
    const ids = await accessibleProjectIds(this.prisma.client, { type: 'AGENT', id: agentId });
    if (ids.length === 0) return [];
    return this.prisma.client.project.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { slug: true, name: true },
      orderBy: { slug: 'asc' },
      take: ids.length,
    });
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

  /**
   * US-002: the project's local agent roster — one row per locally bound principal,
   * ordered by agent name, with roles, capabilities, the adding user's id and
   * name, and a grouped open-ticket summary. "Open" excludes CLOSED, REJECTED,
   * and soft-deleted tickets (soft-deleted rows are filtered server-side, not
   * counted and not surfaced as refs).
   *
   * The open-ticket counts and the ref list come from one grouped query per
   * list call: refs are sorted by `createdAt ASC` and capped at 10 so the
   * total count and the ref list are consistent inside a single snapshot.
   */
  async findProjectRoster(projectId: string): Promise<ProjectAgentRecord[]> {
    const memberships = await listProjectMemberships(this.prisma.client, projectId, 'AGENT');
    if (memberships.length === 0) return [];
    const byId = new Map(memberships.map((row) => [row.principalId, row]));
    const userIds = [...new Set(memberships.flatMap((row) => row.addedByUserId ? [row.addedByUserId] : []))];
    const [agents, users] = await Promise.all([
      this.prisma.client.agent.findMany({
        where: { id: { in: memberships.map((row) => row.principalId) } },
        orderBy: { name: 'asc' },
        select: {
          id: true, slug: true, name: true, status: true,
          roles: { select: { role: true } },
          capabilities: { select: { capability: true } },
        },
        take: memberships.length,
      }),
      userIds.length === 0 ? Promise.resolve([]) : this.prisma.client.user.findMany({
        where: { id: { in: userIds } }, select: { id: true, name: true }, take: userIds.length,
      }),
    ]);
    const userNames = new Map(users.map((user) => [user.id, user.name]));
    const rosterRows = agents.map((agent) => {
      const membership = byId.get(agent.id);
      if (!membership) {
        throw new KodaError('MEMBERSHIP_NOT_FOUND', `agent ${agent.id} has no source in project ${projectId}`);
      }
      return {
        agent,
        createdAt: membership.since,
        addedById: membership.addedByUserId,
        addedByName: membership.addedByUserId ? userNames.get(membership.addedByUserId) ?? null : null,
      };
    });
    const agentSlugs = rosterRows.map((row) => row.agent.slug);

    const openTickets = await this.db.ticket.findMany({
      where: {
        projectId,
        assignedToAgent: { slug: { in: agentSlugs } },
        status: { notIn: [TicketStatus.CLOSED, TicketStatus.REJECTED] },
        deletedAt: null,
      },
      select: {
        number: true,
        createdAt: true,
        assignedToAgent: { select: { slug: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const projectKeyRow = await this.db.project.findUnique({
      where: { id: projectId },
      select: { key: true },
    });
    if (!projectKeyRow) {
      throw new KodaError('PROJECT_NOT_FOUND', `project ${projectId} disappeared while reading its agent roster`);
    }
    const projectKey = projectKeyRow.key;

    const byAgent = new Map<string, { count: number; refs: string[] }>();
    for (const slug of agentSlugs) byAgent.set(slug, { count: 0, refs: [] });

    for (const ticket of openTickets) {
      const slug = ticket.assignedToAgent?.slug;
      if (!slug) continue;
      const bucket = byAgent.get(slug);
      if (!bucket) continue;
      bucket.count += 1;
      if (bucket.refs.length < MAX_OPEN_TICKET_REFS) {
        bucket.refs.push(`${projectKey}-${ticket.number}`);
      }
    }

    return rosterRows.map((row) => {
      const bucket = byAgent.get(row.agent.slug) ?? { count: 0, refs: [] };
      return {
        slug: row.agent.slug,
        name: row.agent.name,
        status: row.agent.status,
        roles: row.agent.roles.map((r) => r.role),
        capabilities: row.agent.capabilities.map((c) => c.capability),
        openTicketCount: bucket.count,
        openTicketRefs: bucket.refs,
        addedAt: row.createdAt,
        addedById: row.addedById,
        addedByName: row.addedByName,
      };
    });
  }
}

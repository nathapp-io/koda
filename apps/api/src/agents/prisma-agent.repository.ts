import { Injectable } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { TicketStatus } from '../common/enums';
import { KodaError } from '../common/koda-error';
import { lockProjectAgents } from '../common/utils/advisory-lock';
import type { ProjectAgentRecord } from './dto/project-agent.dto';

/** US-002: at most this many refs surface in the open-ticket list per roster row. */
const MAX_OPEN_TICKET_REFS = 10;

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
   * S4c US-003 (D530): add the agent to the project's roster. The composite
   * primary key makes a concurrent duplicate add a race, so the insert skips
   * the conflicting row instead of throwing and reports which happened — the
   * caller turns 'alreadyAssigned' into a 409.
   */
  async addToProjectRoster(
    agentId: string,
    projectId: string,
    addedById: string,
  ): Promise<'created' | 'alreadyAssigned'> {
    const { count } = await this.db.agentProject.createMany({
      data: [{ agentId, projectId, addedById }],
      skipDuplicates: true,
    });
    return count === 1 ? 'created' : 'alreadyAssigned';
  }

  /**
   * S4c US-003 (D531): the agent's open tickets in the project — `count` is the
   * exact total, `refs` the oldest {@link MAX_OPEN_TICKET_REFS} as
   * `<Project.key>-<number>`. "Open" means not CLOSED/REJECTED and not
   * soft-deleted, the same rule the roster read uses.
   *
   * The queries run one after another on purpose: this is called inside
   * `AgentsService.removeFromProject`'s `txManager.run`, so `db` is a single
   * interactive transaction client, and issuing concurrent queries on one
   * connection is not safe on every driver (the pg adapter warns about exactly
   * that). A project row that cannot be read is an invariant failure — a ref
   * without its project key would surface a malformed `<key>-<number>` to the
   * user, so refuse instead of degrading.
   */
  async countOpenProjectTickets(agentId: string, projectId: string): Promise<{ count: number; refs: string[] }> {
    const where = {
      projectId,
      assignedToAgentId: agentId,
      status: { notIn: [TicketStatus.CLOSED, TicketStatus.REJECTED] },
      deletedAt: null,
    };
    const count = await this.db.ticket.count({ where });
    const oldest = await this.db.ticket.findMany({
      where,
      select: { number: true },
      orderBy: [{ createdAt: 'asc' }, { number: 'asc' }],
      take: MAX_OPEN_TICKET_REFS,
    });
    if (oldest.length === 0) return { count, refs: [] };

    const project = await this.db.project.findUnique({ where: { id: projectId }, select: { key: true } });
    if (!project) {
      throw new KodaError(
        'PROJECT_NOT_FOUND',
        `project ${projectId} disappeared while counting open tickets for agent ${agentId}`,
      );
    }
    return { count, refs: oldest.map((ticket) => `${project.key}-${ticket.number}`) };
  }

  /** S4c US-003 (D530): drop the agent's roster row. A missing row deletes nothing. */
  async removeFromProjectRoster(agentId: string, projectId: string): Promise<void> {
    await this.db.agentProject.deleteMany({ where: { agentId, projectId } });
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

  /**
   * US-002: the project's explicit agent roster — one row per AgentProject,
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
    const rosterRows = await this.db.agentProject.findMany({
      where: { projectId },
      orderBy: { agent: { name: 'asc' } },
      select: {
        createdAt: true,
        addedById: true,
        addedBy: { select: { id: true, name: true } },
        agent: {
          select: {
            slug: true,
            name: true,
            status: true,
            roles: { select: { role: true } },
            capabilities: { select: { capability: true } },
          },
        },
      },
    });

    if (rosterRows.length === 0) return [];

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
        addedByName: row.addedBy?.name ?? null,
      };
    });
  }
}

import { Inject, Injectable } from '@nestjs/common';
import {
  AbstractPrismaRepository,
  PrismaClientLike,
  PrismaModelDelegate,
  PrismaService,
} from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaClient, ProjectMember } from '../../generated/prisma/client';
import {
  AssigneeDomain,
  IProjectAssigneesRepository,
  ProjectMembershipDomain,
} from './domain/project-assignee.domain';

/** S4c US-004 §3.3: only an agent that could actually work a ticket is offered. */
const ASSIGNABLE_AGENT_STATUSES = ['ACTIVE', 'PAUSED'] as const;

@Injectable()
export class PrismaProjectAssigneesRepository
  extends AbstractPrismaRepository<ProjectMembershipDomain, ProjectMember, string>
  implements IProjectAssigneesRepository
{
  constructor(
    @Inject(TRANSACTION_MANAGER) tx: ITransactionManager,
    private readonly prisma: PrismaService<PrismaClient>,
  ) {
    super(tx);
  }

  protected modelDelegate(client: PrismaClientLike): PrismaModelDelegate<ProjectMember, string> {
    return (client as unknown as PrismaClient).projectMember as unknown as PrismaModelDelegate<ProjectMember, string>;
  }

  protected toDomain(m: ProjectMember): ProjectMembershipDomain {
    return {
      id: m.id,
      projectId: m.projectId,
      userId: m.userId,
      role: m.role,
      joinedAt: m.joinedAt,
    };
  }

  protected toPersistenceCreate(d: ProjectMembershipDomain) {
    return { projectId: d.projectId, userId: d.userId, role: d.role };
  }

  protected toPersistenceUpdate(patch: Partial<ProjectMembershipDomain>) {
    const data: { projectId?: string; userId?: string; role?: string } = {};
    if (patch.projectId !== undefined) data.projectId = patch.projectId;
    if (patch.userId !== undefined) data.userId = patch.userId;
    if (patch.role !== undefined) data.role = patch.role;
    return data;
  }

  /**
   * Bounded account reads over the supplied project.read holders. Enabled/status filters,
   * ordering and the combined limit stay here. q is a literal, case-insensitive substring.
   */
  async search(_projectId: string, q: string, limit: number, ids: { userIds: string[]; agentIds: string[] }): Promise<AssigneeDomain[]> {
    const needle = q.length > 0 ? q : undefined;
    const db = this.prisma.client;
    const { userIds, agentIds } = ids;

    const [users, agents] = await Promise.all([
      db.user.findMany({
        where: {
          id: { in: userIds },
          disabled: false,
          ...(needle && {
            OR: [
              { name: { contains: needle, mode: 'insensitive' } },
              { email: { contains: needle, mode: 'insensitive' } },
            ],
          }),
        },
        select: { id: true, name: true, email: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: limit,
      }),
      db.agent.findMany({
        where: {
          id: { in: agentIds },
          status: { in: [...ASSIGNABLE_AGENT_STATUSES] },
          ...(needle && {
            OR: [
              { name: { contains: needle, mode: 'insensitive' } },
              { slug: { contains: needle, mode: 'insensitive' } },
            ],
          }),
        },
        select: { id: true, name: true, slug: true, status: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: limit,
      }),
    ]);

    // Users first, then agents; `limit` caps the combined list, so a page of
    // matching users can fill it without an agent being offered.
    return [
      ...users.map((user) => ({
        type: 'user' as const,
        id: user.id,
        name: user.name ?? user.email,
        secondary: user.email,
      })),
      ...agents.map((agent) => ({
        type: 'agent' as const,
        id: agent.id,
        name: agent.name,
        secondary: agent.slug,
        status: agent.status,
      })),
    ].slice(0, limit);
  }
}

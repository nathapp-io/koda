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
   * Two bounded reads rather than one union: users come from the project's
   * memberships, agents from its roster, and `contains` keeps `%` and `_`
   * literal (Prisma escapes them), so q is a plain substring, not a pattern.
   */
  async search(projectId: string, q: string, limit: number): Promise<AssigneeDomain[]> {
    const needle = q.length > 0 ? q : undefined;

    const members = await this.prisma.client.projectMember.findMany({
      where: {
        projectId,
        user: {
          disabled: false,
          ...(needle && {
            OR: [
              { name: { contains: needle, mode: 'insensitive' } },
              { email: { contains: needle, mode: 'insensitive' } },
            ],
          }),
        },
      },
      select: { userId: true, user: { select: { name: true, email: true } } },
      orderBy: [{ user: { name: 'asc' } }, { userId: 'asc' }],
      take: limit,
    });

    const roster = await this.prisma.client.agentProject.findMany({
      where: {
        projectId,
        agent: {
          status: { in: [...ASSIGNABLE_AGENT_STATUSES] },
          ...(needle && {
            OR: [
              { name: { contains: needle, mode: 'insensitive' } },
              { slug: { contains: needle, mode: 'insensitive' } },
            ],
          }),
        },
      },
      select: { agentId: true, agent: { select: { name: true, slug: true, status: true } } },
      orderBy: [{ agent: { name: 'asc' } }, { agentId: 'asc' }],
      take: limit,
    });

    // Users first, then agents; `limit` caps the combined list, so a page of
    // matching users can fill it without an agent being offered.
    return [
      ...members.map((member) => ({
        type: 'user' as const,
        id: member.userId,
        name: member.user.name ?? member.user.email,
        secondary: member.user.email,
      })),
      ...roster.map((entry) => ({
        type: 'agent' as const,
        id: entry.agentId,
        name: entry.agent.name,
        secondary: entry.agent.slug,
        status: entry.agent.status,
      })),
    ].slice(0, limit);
  }
}

import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { PrismaClient } from '../../generated/prisma/client';
import { countActiveProjectAdmins, listProjectMemberships, type ProjectMembership } from '../../permissions/membership.queries';
import { lockProjectMembers } from '../../common/utils/advisory-lock';
import { MemberPrincipalType, ProjectMemberRecord } from './domain/project-member.domain';
import { MemberPrincipalFilter } from './dto/list-members.query';
import { memberKey, readMemberBindings, readMemberRecord } from './project-member.queries';

/** The user columns a member row needs. */
type MemberUserRow = { id: string; email: string; name: string | null; disabled: boolean };

/** The agent columns a member row needs: no account state, but a slug clients link on. */
type MemberAgentRow = { id: string; name: string; slug: string };

@Injectable()
export class PrismaProjectMembersRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  /**
   * One page of the project's memberships. `principals` decides whether the agent principals are
   * members of the page: with `users` the page is the user rows only, and with `all` it is the user
   * rows in their own order followed by the agent rows in the same order, `total` counting both.
   *
   * Both listings are read before the slice, so page `n` is a window of the combined list rather than
   * two independent windows — that is what makes `principals=all` a single unified listing.
   */
  async findMemberPage(
    projectId: string,
    page: IPageOption,
    principals: MemberPrincipalFilter = 'users',
  ): Promise<IPageResult<ProjectMemberRecord>> {
    const [userMemberships, agentMemberships] = await Promise.all([
      listProjectMemberships(this.db, projectId, 'USER'),
      principals === 'all' ? listProjectMemberships(this.db, projectId, 'AGENT') : Promise.resolve([]),
    ]);
    const memberships: Array<{ type: MemberPrincipalType; membership: ProjectMembership }> = [
      ...userMemberships.map((membership) => ({ type: 'USER' as const, membership })),
      ...agentMemberships.map((membership) => ({ type: 'AGENT' as const, membership })),
    ];

    const offset = (page.current - 1) * page.size;
    const slice = memberships.slice(offset, offset + page.size);
    const userIds = slice.filter((entry) => entry.type === 'USER').map((entry) => entry.membership.principalId);
    const agentIds = slice.filter((entry) => entry.type === 'AGENT').map((entry) => entry.membership.principalId);

    const [users, agents, bindings] = await Promise.all([
      this.readUsers(userIds),
      this.readAgents(agentIds),
      readMemberBindings(this.db, projectId, { userIds, agentIds }),
    ]);
    const userById = new Map(users.map((user) => [user.id, user]));
    const agentById = new Map(agents.map((agent) => [agent.id, agent]));

    const records = slice.map(({ type, membership }): ProjectMemberRecord => {
      const chips = bindings.get(memberKey(type, membership.principalId)) ?? [];
      if (type === 'USER') {
        const user = userById.get(membership.principalId);
        if (!user) throw new NotFoundAppException({}, 'members');
        return {
          userId: user.id,
          email: user.email,
          name: user.name,
          disabled: user.disabled,
          joinedAt: membership.since,
          principalType: 'USER',
          principalId: user.id,
          agentSlug: null,
          bindings: chips,
        };
      }
      // An agent principal has no account state, so no row of it is disabled.
      const agent = agentById.get(membership.principalId);
      if (!agent) throw new NotFoundAppException({}, 'members');
      return {
        userId: null,
        email: null,
        name: agent.name,
        disabled: false,
        joinedAt: membership.since,
        principalType: 'AGENT',
        principalId: agent.id,
        agentSlug: agent.slug,
        bindings: chips,
      };
    });

    return {
      records,
      total: memberships.length,
      current: page.current,
      size: page.size,
      hasNext: offset + page.size < memberships.length,
      hasPrev: page.current > 1,
    };
  }

  /** One user's record with its chips; null when the user has no source in the project. */
  async findMember(projectId: string, userId: string): Promise<ProjectMemberRecord | null> {
    return readMemberRecord(this.db, projectId, { type: 'USER', id: userId });
  }

  /** Case-insensitive so admins do not need the exact stored casing. */
  async findUserIdByEmail(email: string): Promise<string | null> {
    const u = await this.db.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true },
    });
    return u?.id ?? null;
  }

  /**
   * S4c US-003: the user plus the account state the membership gate needs — a
   * disabled account must not be granted membership.
   */
  async findUserByEmail(email: string): Promise<{ id: string; disabled: boolean } | null> {
    const u = await this.db.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true, disabled: true },
    });
    return u ?? null;
  }

  /** Active admins only: a disabled user cannot act, so must not satisfy the guard. */
  async countProjectAdmins(projectId: string): Promise<number> {
    return countActiveProjectAdmins(this.db, projectId);
  }

  /** Serializes last-project-admin checks. Call inside txManager.run only. */
  async lockMembers(projectId: string): Promise<void> {
    await lockProjectMembers(this.db, projectId);
  }

  /** The account state of the page's user rows, in one read (the ids are the page's, so bounded). */
  private async readUsers(ids: readonly string[]): Promise<MemberUserRow[]> {
    if (ids.length === 0) return [];
    return this.db.user.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, email: true, name: true, disabled: true },
      take: ids.length,
    });
  }

  /** The identity of the page's agent rows: an agent principal has a name and a slug, and no account state. */
  private async readAgents(ids: readonly string[]): Promise<MemberAgentRow[]> {
    if (ids.length === 0) return [];
    return this.db.agent.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, name: true, slug: true },
      take: ids.length,
    });
  }
}

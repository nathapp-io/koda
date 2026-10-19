import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { PrismaClient, ProjectMember, User } from '../../generated/prisma/client';
import { countActiveProjectAdmins, listProjectMemberships, localProjectRole } from '../../permissions/legacy-membership.queries';
import { lockProjectMembers } from '../../common/utils/advisory-lock';
import { ProjectMemberRecord, ProjectMemberRole } from './domain/project-member.domain';

type MemberRow = ProjectMember & { user: User };

@Injectable()
export class PrismaProjectMembersRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  private toRecord(m: MemberRow): ProjectMemberRecord {
    return {
      userId: m.userId,
      email: m.user.email,
      name: m.user.name,
      role: m.role,
      disabled: m.user.disabled,
      joinedAt: m.joinedAt,
    };
  }

  async findMemberPage(projectId: string, page: IPageOption): Promise<IPageResult<ProjectMemberRecord>> {
    const memberships = await listProjectMemberships(this.db, projectId, 'USER');
    const offset = (page.current - 1) * page.size;
    const slice = memberships.slice(offset, offset + page.size);
    const users = await this.db.user.findMany({
      where: { id: { in: slice.map(m => m.principalId) } },
      select: { id: true, email: true, name: true, disabled: true },
      take: page.size,
    });
    const byId = new Map(users.map(user => [user.id, user]));
    const records = slice.map(m => {
      const user = byId.get(m.principalId);
      if (!user) throw new NotFoundAppException({}, 'members');
      return { userId: user.id, email: user.email, name: user.name, disabled: user.disabled, role: m.role, joinedAt: m.since };
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

  async findMember(projectId: string, userId: string): Promise<ProjectMemberRecord | null> {
    const role = await localProjectRole(this.db, { type: 'USER', id: userId }, projectId);
    if (role === null) return null;
    const [user, memberships] = await Promise.all([
      this.db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true, disabled: true } }),
      listProjectMemberships(this.db, projectId, 'USER'),
    ]);
    const membership = memberships.find(m => m.principalId === userId);
    if (!user || !membership) return null;
    return { userId, email: user.email, name: user.name, disabled: user.disabled, role, joinedAt: membership.since };
  }

  async deleteMemberIfPresent(projectId: string, userId: string): Promise<void> {
    await this.db.projectMember.deleteMany({ where: { projectId, userId } });
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

  async createMember(projectId: string, userId: string, role: ProjectMemberRole): Promise<ProjectMemberRecord> {
    const m = await this.db.projectMember.create({ data: { projectId, userId, role }, include: { user: true } });
    return this.toRecord(m);
  }

  async updateMemberRole(projectId: string, userId: string, role: ProjectMemberRole): Promise<ProjectMemberRecord> {
    const m = await this.db.projectMember.update({
      where: { projectId_userId: { projectId, userId } },
      data: { role },
      include: { user: true },
    });
    return this.toRecord(m);
  }

  async deleteMember(projectId: string, userId: string): Promise<void> {
    await this.db.projectMember.delete({ where: { projectId_userId: { projectId, userId } } });
  }

  /** Active admins only: a disabled user cannot act, so must not satisfy the guard. */
  async countProjectAdmins(projectId: string): Promise<number> {
    return countActiveProjectAdmins(this.db, projectId);
  }

  /** Serializes last-project-admin checks. Call inside txManager.run only. */
  async lockMembers(projectId: string): Promise<void> {
    await lockProjectMembers(this.db, projectId);
  }
}

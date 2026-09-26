import { Injectable } from '@nestjs/common';
import { Paginate, PrismaService } from '@nathapp/nestjs-prisma';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { PrismaClient, ProjectMember, User } from '@prisma/client';
import { ActorRole } from '../../common/enums';
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
    return { userId: m.userId, email: m.user.email, name: m.user.name, role: m.role, joinedAt: m.joinedAt };
  }

  async findMemberPage(projectId: string, page: IPageOption): Promise<IPageResult<ProjectMemberRecord>> {
    const rows = await Paginate(this.db.projectMember, page, {
      where: { projectId },
      include: { user: true },
      orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.remap((m: MemberRow) => this.toRecord(m));
  }

  async findMember(projectId: string, userId: string): Promise<ProjectMemberRecord | null> {
    const m = await this.db.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      include: { user: true },
    });
    return m ? this.toRecord(m) : null;
  }

  async findUserIdByEmail(email: string): Promise<string | null> {
    const u = await this.db.user.findUnique({ where: { email }, select: { id: true } });
    return u?.id ?? null;
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

  async countProjectAdmins(projectId: string): Promise<number> {
    return this.db.projectMember.count({ where: { projectId, role: ActorRole.ADMIN } });
  }

  /** Serializes last-project-admin checks. Call inside txManager.run only. */
  async lockMembers(projectId: string): Promise<void> {
    await lockProjectMembers(this.db, projectId);
  }
}

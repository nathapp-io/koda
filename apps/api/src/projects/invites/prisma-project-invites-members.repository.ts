import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient, ProjectMember, User } from '../../generated/prisma/client';
import { ProjectMemberRecord, ProjectMemberRole } from '../members/domain/project-member.domain';

type MemberRow = ProjectMember & { user: User };

export interface InviteUserState {
  id: string;
  email: string;
  disabled: boolean;
}

/**
 * Fleet S4b US-004: the invites module's own membership and user reads/writes. `ProjectMembersModule`'s
 * service is deliberately not imported — the invites feature only needs to add a member by user id.
 */
@Injectable()
export class PrismaProjectInvitesMembersRepository {
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

  /** Case-insensitive so an admin can re-type the address in any casing. */
  async findUserIdByEmail(email: string): Promise<string | null> {
    const u = await this.db.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true },
    });
    return u?.id ?? null;
  }

  async findUserState(userId: string): Promise<InviteUserState | null> {
    return this.db.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, disabled: true },
    });
  }

  async createMember(projectId: string, userId: string, role: ProjectMemberRole): Promise<ProjectMemberRecord> {
    const m = await this.db.projectMember.create({ data: { projectId, userId, role }, include: { user: true } });
    return this.toRecord(m);
  }
}

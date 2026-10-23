import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { PrismaClient } from '../../generated/prisma/client';
import { lockProjectMembers } from '../../common/utils/advisory-lock';
import { localProjectRole } from '../../permissions/membership.queries';
import { UserDomain } from '../../auth/domain/auth.domain';
import { ProjectMemberRecord, ProjectMemberRole } from '../members/domain/project-member.domain';
import { readMemberRecord } from '../members/project-member.queries';

export interface InviteUserState {
  id: string;
  email: string;
  name: string | null;
  disabled: boolean;
}

/** US-005: a member account created by accepting an invite — never an ADMIN. */
export interface CreateInvitedUserInput {
  email: string;
  name: string;
  passwordHash: string;
}

/**
 * Fleet S4b US-004: the invites module's own membership and user reads/writes. `ProjectMembersModule`'s
 * service is deliberately not imported — the invites feature only needs to add a member by user id.
 *
 * US-003: a member record read here goes through the same `readMemberRecord` the members module uses —
 * the invites routes answer the member's `ProjectMemberDto`, chips included, so both paths must map a
 * membership identically.
 */
@Injectable()
export class PrismaProjectInvitesMembersRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
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
      select: { id: true, email: true, name: true, disabled: true },
    });
  }

  async lockMembers(projectId: string): Promise<void> {
    await lockProjectMembers(this.db, projectId);
  }

  async findLocalRole(projectId: string, userId: string): Promise<string | null> {
    return localProjectRole(this.db, { type: 'USER', id: userId }, projectId);
  }

  /** The member record an invite's `ADDED` outcome answers: the same shape the members routes return. */
  async findMember(projectId: string, userId: string): Promise<ProjectMemberRecord | null> {
    return readMemberRecord(this.db, projectId, { type: 'USER', id: userId });
  }

  async findRequiredMember(projectId: string, userId: string): Promise<ProjectMemberRecord> {
    const record = await this.findMember(projectId, userId);
    if (!record) throw new NotFoundAppException({}, 'members');
    return record;
  }

  async createMember(projectId: string, userId: string, role: ProjectMemberRole): Promise<ProjectMemberRecord> {
    await this.db.projectMember.create({ data: { projectId, userId, role } });
    return this.findRequiredMember(projectId, userId);
  }

  /**
   * US-005: the account an accepted invite creates. The role is always the global MEMBER role —
   * project authority comes from the membership row, never from the user row.
   */
  async createInvitedUser(input: CreateInvitedUserInput): Promise<UserDomain> {
    const m = await this.db.user.create({
      data: { email: input.email, name: input.name, passwordHash: input.passwordHash, role: 'MEMBER' },
    });
    return {
      id: m.id,
      email: m.email,
      name: m.name ?? input.name,
      role: m.role,
      passwordHash: m.passwordHash,
      tokenVersion: m.tokenVersion,
      disabled: m.disabled,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  }
}

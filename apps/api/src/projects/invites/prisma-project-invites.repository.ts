import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../generated/prisma/client';
import { ProjectMemberRole } from '../members/domain/project-member.domain';
import { InviteStatus, ProjectInviteRecord } from './domain/project-invite.domain';

/** A `ProjectInvite` row plus the inviter's display name and the project name. */
type InviteRow = {
  id: string;
  projectId: string;
  email: string;
  role: string;
  tokenHash: string;
  status: string;
  invitedById: string;
  acceptedByUserId: string | null;
  acceptedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  invitedBy: { name: string | null } | null;
  project: { name: string };
};

const INCLUDE_CONTEXT = {
  invitedBy: { select: { name: true } },
  project: { select: { name: true } },
} as const;

/** An invite plus the two display names the inline email needs (spec §4.1). */
export interface ProjectInviteWithContext extends ProjectInviteRecord {
  projectName: string;
}

export interface CreateProjectInviteInput {
  projectId: string;
  email: string;
  role: ProjectMemberRole;
  tokenHash: string;
  invitedById: string;
  expiresAt: Date;
}

/**
 * Fleet S4b US-004: module-private persistence for `ProjectInvite`. Only the token hash is ever written;
 * the raw token exists in the service's create/resend response and the invite email (D526).
 */
@Injectable()
export class PrismaProjectInvitesRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  /** Supersedes an earlier pending invite for the same project and address (AC-7). */
  async cancelPending(projectId: string, email: string): Promise<number> {
    const result = await this.db.projectInvite.updateMany({
      where: { projectId, email, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
    return result.count;
  }

  async create(input: CreateProjectInviteInput): Promise<ProjectInviteWithContext> {
    const model = await this.db.projectInvite.create({
      data: {
        projectId: input.projectId,
        email: input.email,
        role: input.role,
        tokenHash: input.tokenHash,
        invitedById: input.invitedById,
        expiresAt: input.expiresAt,
      },
      include: INCLUDE_CONTEXT,
    });
    return this.toContext(model as InviteRow);
  }

  /** Newest first, so an admin sees the invite they just sent at the top. */
  async list(projectId: string): Promise<ProjectInviteRecord[]> {
    const rows = await this.db.projectInvite.findMany({
      where: { projectId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: INCLUDE_CONTEXT,
    });
    return (rows as InviteRow[]).map((row) => this.toRecord(row));
  }

  private toContext(row: InviteRow): ProjectInviteWithContext {
    return { ...this.toRecord(row), projectName: row.project.name };
  }

  private toRecord(row: InviteRow): ProjectInviteRecord {
    return {
      id: row.id,
      projectId: row.projectId,
      email: row.email,
      role: row.role as ProjectMemberRole,
      status: row.status as InviteStatus,
      invitedById: row.invitedById,
      inviterName: row.invitedBy?.name ?? null,
      acceptedByUserId: row.acceptedByUserId,
      acceptedAt: row.acceptedAt,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    };
  }
}

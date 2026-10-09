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

/** US-005: the anonymous preview also shows the project's slug. */
type InvitePreviewRow = InviteRow & { project: { name: string; slug: string } };

const INCLUDE_CONTEXT = {
  invitedBy: { select: { name: true } },
  project: { select: { name: true } },
} as const;

const INCLUDE_PREVIEW = {
  invitedBy: { select: { name: true } },
  project: { select: { name: true, slug: true } },
} as const;

/**
 * The invite list is not paginated, so the newest page is capped. `ProjectInvite` grows with every invite
 * ever created for a project; a bare `findMany` would make both the query and the `GET /projects/:slug/invites`
 * response grow without bound (api-data rules, Pagination Anti-Patterns).
 */
const LIST_LIMIT = 200;

/** An invite plus the two display names the inline email needs (spec §4.1). */
export interface ProjectInviteWithContext extends ProjectInviteRecord {
  projectName: string;
}

/** US-005: everything the public preview and the accept transaction read from the invite row. */
export interface ProjectInvitePreview extends ProjectInviteWithContext {
  projectSlug: string;
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
      take: LIST_LIMIT,
    });
    return (rows as InviteRow[]).map((row) => this.toRecord(row));
  }

  /** US-005: the only lookup the anonymous preview/accept path may use — the raw token never reaches SQL. */
  async findByTokenHash(tokenHash: string): Promise<ProjectInvitePreview | null> {
    const row = await this.db.projectInvite.findUnique({ where: { tokenHash }, include: INCLUDE_PREVIEW });
    return row ? this.toPreview(row as InvitePreviewRow) : null;
  }

  /** US-005: admin resend/cancel scope an invite to its project, so another project's id is a 404. */
  async findByIdForProject(projectId: string, id: string): Promise<ProjectInviteWithContext | null> {
    const row = await this.db.projectInvite.findFirst({
      where: { id, projectId },
      include: INCLUDE_CONTEXT,
    });
    return row ? this.toContext(row as InviteRow) : null;
  }

  /**
   * US-005 AC-7: the single use of the token is a conditional update, so two concurrent accepts
   * serialize on the row lock and exactly one sees `count: 1`. Returns false when the invite is
   * already accepted/cancelled or has expired.
   *
   * The presented `tokenHash` is part of the guard, not just the lookup key: a resend that rotates
   * the hash between the caller's read and this update makes the row fail the WHERE (the update
   * re-checks it under the row lock), so the superseded link cannot be redeemed (AC-8).
   */
  async claimPending(id: string, tokenHash: string, now: Date): Promise<boolean> {
    const result = await this.db.projectInvite.updateMany({
      where: { id, tokenHash, status: 'PENDING', expiresAt: { gt: now } },
      data: { status: 'ACCEPTED', acceptedAt: now },
    });
    return result.count === 1;
  }

  /** Second half of the accept transaction: the user id only exists after the user row is created. */
  async setAcceptedBy(id: string, userId: string, now: Date): Promise<void> {
    await this.db.projectInvite.update({
      where: { id },
      data: { acceptedByUserId: userId, acceptedAt: now },
    });
  }

  /**
   * US-005: resend rotates the token and restarts the clock, but only while the invite is still
   * PENDING (an expired row keeps status PENDING — EXPIRED is computed on read). Returns null when
   * an accept or cancel won the race, so the caller can answer 409 without having written anything.
   *
   * The guard is the row's *current* hash, read here rather than taken from the caller's earlier
   * lookup: two concurrent resends would otherwise both match (rotation leaves the row PENDING) and
   * both report success, one of them handing back a link that the other had already superseded. The
   * hash never leaves this repository — the module's public records deliberately omit it.
   */
  async rotate(input: {
    id: string;
    projectId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<ProjectInviteWithContext | null> {
    const current = await this.db.projectInvite.findFirst({
      where: { id: input.id, projectId: input.projectId },
      select: { tokenHash: true },
    });
    if (!current) return null;

    const result = await this.db.projectInvite.updateMany({
      where: {
        id: input.id,
        projectId: input.projectId,
        tokenHash: current.tokenHash,
        status: 'PENDING',
      },
      data: { tokenHash: input.tokenHash, status: 'PENDING', expiresAt: input.expiresAt },
    });
    if (result.count !== 1) return null;

    const row = await this.db.projectInvite.findUnique({ where: { id: input.id }, include: INCLUDE_CONTEXT });
    return row ? this.toContext(row as InviteRow) : null;
  }

  /** US-005: cancel is final and only ever moves a PENDING row; anything else left untouched. */
  async cancel(id: string, projectId: string): Promise<boolean> {
    const result = await this.db.projectInvite.updateMany({
      where: { id, projectId, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
    return result.count === 1;
  }

  private toContext(row: InviteRow): ProjectInviteWithContext {
    return { ...this.toRecord(row), projectName: row.project.name };
  }

  private toPreview(row: InvitePreviewRow): ProjectInvitePreview {
    return { ...this.toContext(row), projectSlug: row.project.slug };
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

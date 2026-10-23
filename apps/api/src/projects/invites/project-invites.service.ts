import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { EmailAvailability } from '../../email/email-availability';
import { EmailScheduleService } from '../../email/schedule/email-schedule.service';
import { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { MembershipService } from '../../permissions/membership.service';
import { LegacyProjectRole, legacyRoleForRoleKey, ROLE_KEY_FOR_LEGACY_ROLE } from '../../permissions/legacy-project-roles';
import { RoleDomain } from '../../permissions/permissions.types';
import { RoleAdminService } from '../../permissions/role-admin.service';
import { ProjectAccessService } from '../project-access.service';
import { ProjectMemberDto } from '../members/dto/project-member.dto';
import { ProjectMemberRecord, ProjectMemberRole } from '../members/domain/project-member.domain';
import { InviteMailer } from './invite-mailer';
import { generateInviteToken } from './invite-token';
import { PrismaProjectInvitesRepository, ProjectInviteWithContext } from './prisma-project-invites.repository';
import { PrismaProjectInvitesMembersRepository, InviteUserState } from './prisma-project-invites-members.repository';
import { effectiveStatus, ProjectInviteRecord } from './domain/project-invite.domain';
import { CreateInviteDto } from './dto/create-invite.dto';
import { InviteCreateResultDto, InviteDto, InviteResendResultDto } from './dto/invite.dto';

const DAY_MS = 86_400_000;
/** Transactional notices carry no user preference, so MEMBER_ADDED is always rendered in English. */
const MEMBER_ADDED_LOCALE = 'en';

/**
 * Fleet S4b US-004: project invites. `create` either adds an existing active user directly or mints a
 * one-time invite for an unknown address (raw token returned once, hash stored); `list` reports the
 * effective status and never exposes token material.
 *
 * Permissions P1 (US-008): the four routes carry `invite.read`/`invite.create`/`invite.resend`/
 * `invite.cancel`, so this service keeps no admin assertion — the seeded non-admin project roles
 * exclude `invite.read`, which keeps the listing (and the whole invite surface) project-admin only.
 * The invite lifecycle rules (a PENDING row only, final rows answer 409) are unchanged.
 */
@Injectable()
export class ProjectInvitesService {
  private readonly logger = new Logger(ProjectInvitesService.name);

  constructor(
    private readonly invites: PrismaProjectInvitesRepository,
    private readonly members: PrismaProjectInvitesMembersRepository,
    private readonly access: ProjectAccessService,
    private readonly mailer: InviteMailer,
    private readonly schedule: EmailScheduleService,
    private readonly email: EmailAvailability,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly membership: MembershipService,
    private readonly roles: RoleAdminService,
  ) {}

  async create(
    slug: string,
    dto: CreateInviteDto,
    principal: KodaPrincipal,
    locale: string,
  ): Promise<InviteCreateResultDto> {
    const roleKey = effectiveRoleKey(dto);
    const projectId = await this.access.findProjectIdBySlug(slug);

    const email = dto.email.trim().toLowerCase();
    const userId = await this.members.findUserIdByEmail(email);
    // Both paths use one order: user lookup, disabled account, grant rules, then the member check.
    if (userId) {
      const user = await this.members.findUserState(userId);
      if (!user || user.disabled) throw new ConflictAppException({}, 'invites.userDisabled');
      const role = await this.assertMayGrant(principal, roleKey, projectId, userId);
      return this.addExistingUser(projectId, user, role, principal);
    }

    const role = await this.assertMayGrant(principal, roleKey, projectId, null);
    return this.inviteNewAddress(projectId, email, role, principal, locale);
  }

  /** The same grant rules `POST /role-bindings` applies, run before anything is written. */
  private assertMayGrant(
    principal: KodaPrincipal,
    roleKey: string,
    projectId: string,
    principalId: string | null,
  ): Promise<RoleDomain> {
    return this.roles.assertMayGrant(principal, { roleKey, projectId, principalType: 'USER', principalId });
  }

  async list(slug: string, principal: KodaPrincipal): Promise<InviteDto[]> {
    const projectId = await this.access.findProjectIdBySlug(slug);

    const now = new Date();
    const records = await this.invites.list(projectId);
    return records.map((record) => this.toDto(record, now));
  }

  /**
   * US-005: rotates the token so a leaked or stale link dies, restarts the TTL and reports whether the
   * replacement email went out. Only a PENDING invite may be resent — an expired row is still PENDING
   * (EXPIRED is computed on read), while ACCEPTED and CANCELLED are final and answer 409.
   */
  async resend(
    slug: string,
    id: string,
    principal: KodaPrincipal,
    locale: string,
  ): Promise<InviteResendResultDto> {
    const projectId = await this.access.findProjectIdBySlug(slug);

    const invite = await this.invites.findByIdForProject(projectId, id);
    if (!invite) throw new NotFoundAppException({}, 'invites');
    if (invite.status !== 'PENDING') throw new ConflictAppException({}, 'invites.final');

    const now = new Date();
    const { raw, hash } = generateInviteToken();
    const expiresAt = new Date(now.getTime() + this.email.config().inviteTtlDays * DAY_MS);
    const rotated = await this.invites.rotate({ id, projectId, tokenHash: hash, expiresAt });
    // An accept or cancel that won the race left a final row; nothing was written, so this is a 409.
    if (!rotated) throw new ConflictAppException({}, 'invites.final');

    const emailed = this.email.configured ? await this.sendInvite(rotated, raw, rotated.email, locale) : false;
    return { invite: this.toDto(rotated, now), invitePath: `/invite/${raw}`, emailed };
  }

  /** US-005: cancel is final. A PENDING invite becomes CANCELLED; anything already final answers 409. */
  async cancel(slug: string, id: string, principal: KodaPrincipal): Promise<void> {
    const projectId = await this.access.findProjectIdBySlug(slug);

    const invite = await this.invites.findByIdForProject(projectId, id);
    if (!invite) throw new NotFoundAppException({}, 'invites');
    if (invite.status !== 'PENDING') throw new ConflictAppException({}, 'invites.final');
    if (!(await this.invites.cancel(id, projectId))) throw new ConflictAppException({}, 'invites.final');
  }

  /** An active account joins immediately; a disabled account (or an existing membership) is a 409. */
  private async addExistingUser(
    projectId: string,
    user: InviteUserState,
    role: RoleDomain,
    principal: KodaPrincipal,
  ): Promise<InviteCreateResultDto> {
    const userId = user.id;

    // Membership write and the MEMBER_ADDED schedule share one transaction: a scheduling
    // failure rolls the membership back so the admin's retry does not hit a 409 for a
    // user that was never actually emailed.
    const member = await this.membership.afterCommit(() => this.txManager.run(async () => {
      await this.members.lockMembers(projectId);
      if ((await this.members.findLocalRole(projectId, userId)) !== null) {
        throw new ConflictAppException({}, 'invites.memberExists');
      }
      await this.membership.createBinding(
        { principal: { type: 'USER', id: userId }, projectId, roleKey: role.key },
        granterOf(principal),
      );
      // Read the written membership back inside the same transaction, so the outcome carries the same
      // record (and the same role chips) the members routes answer with.
      const created: ProjectMemberRecord = await this.members.findRequiredMember(projectId, userId);

      if (this.email.configured) {
        await this.schedule.scheduleMemberAdded({
          userId,
          projectId,
          toEmail: user.email,
          locale: MEMBER_ADDED_LOCALE,
          dueAt: new Date(),
        });
      }
      return created;
    }));

    return { outcome: 'ADDED', member: ProjectMemberDto.from(member) };
  }

  private async inviteNewAddress(
    projectId: string,
    email: string,
    role: RoleDomain,
    principal: KodaPrincipal,
    locale: string,
  ): Promise<InviteCreateResultDto> {
    const now = new Date();
    const { raw, hash } = generateInviteToken();
    const expiresAt = new Date(now.getTime() + this.email.config().inviteTtlDays * DAY_MS);
    const inviter = inviteeOf(principal);

    // Cancel any earlier pending invite and mint the replacement in one transaction (AC-7).
    const invite = await this.txManager.run(async () => {
      await this.invites.cancelPending(projectId, email);
      return this.invites.create({
        projectId,
        email,
        role: legacyNameOf(role.key),
        roleId: role.id,
        tokenHash: hash,
        invitedById: inviter.invitedById,
        invitedByAgentId: inviter.invitedByAgentId,
        expiresAt,
      });
    });

    const emailed = this.email.configured ? await this.sendInvite(invite, raw, email, locale) : false;
    return { outcome: 'INVITED', invite: this.toDto(invite, now), invitePath: `/invite/${raw}`, emailed };
  }

  /**
   * A failed invite email is not retryable (only the hash is stored) and must not fail the request:
   * the admin still gets the link and `emailed: false` (D526).
   */
  private async sendInvite(
    invite: ProjectInviteWithContext,
    rawToken: string,
    toEmail: string,
    locale: string,
  ): Promise<boolean> {
    try {
      return await this.mailer.sendInvite({
        inviteId: invite.id,
        toEmail,
        locale,
        rawToken,
        projectName: invite.projectName,
        inviterName: invite.inviterName ?? '',
        role: invite.roleName ?? invite.role ?? '',
        expiresAt: invite.expiresAt,
      });
    } catch (error) {
      this.logger.warn(`invite email for invite ${invite.id} failed: ${error instanceof Error ? error.message : error}`);
      return false;
    }
  }

  private toDto(record: ProjectInviteRecord, now: Date): InviteDto {
    return {
      id: record.id,
      email: record.email,
      role: record.role,
      roleKey: record.roleKey,
      roleName: record.roleName,
      status: effectiveStatus(record, now),
      inviterName: record.inviterName,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
    };
  }
}

/**
 * US-005: `roleKey` names the role to grant. US-004 (P1l): it is the only way — the legacy `role` field is
 * gone, so an invite that omits the key is a client bug and answers 400 `invites.roleRequired`.
 */
function effectiveRoleKey(dto: CreateInviteDto): string {
  if (dto.roleKey === undefined) throw new ValidationAppException({}, 'invites.roleRequired');
  return dto.roleKey;
}

/** The legacy enum stored beside `roleId`: only the three keys that have a legacy name, null for any other. */
function legacyNameOf(roleKey: string): LegacyProjectRole | null {
  const legacy = legacyRoleForRoleKey(roleKey);
  return ROLE_KEY_FOR_LEGACY_ROLE[legacy] === roleKey ? legacy : null;
}

/**
 * Permissions P1 (US-008): `invite.create` reaches a project-admin agent too, so the inviter is stored in
 * the column of its own actor type. `ProjectInvite.invitedById` is a foreign key to `User`; writing an
 * agent id there failed with a P2003 instead of creating the invite.
 */
function inviteeOf(principal: KodaPrincipal): { invitedById: string | null; invitedByAgentId: string | null } {
  return principal.actorType === 'agent'
    ? { invitedById: null, invitedByAgentId: principal.id }
    : { invitedById: principal.id, invitedByAgentId: null };
}

/** The `RoleBinding` granter of the same actor type as the caller that made the write. */
function granterOf(principal: KodaPrincipal): { type: 'USER' | 'AGENT'; id: string } {
  return { type: principal.actorType === 'agent' ? 'AGENT' : 'USER', id: principal.id };
}

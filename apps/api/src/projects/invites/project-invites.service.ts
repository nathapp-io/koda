import { Inject, Injectable, Logger } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { EmailAvailability } from '../../email/email-availability';
import { EmailScheduleService } from '../../email/schedule/email-schedule.service';
import { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { isUniqueViolation } from '../../common/utils/prisma-errors';
import { ProjectAccessService } from '../project-access.service';
import { ProjectMemberDto } from '../members/dto/project-member.dto';
import { ProjectMemberRecord, ProjectMemberRole } from '../members/domain/project-member.domain';
import { InviteMailer } from './invite-mailer';
import { generateInviteToken } from './invite-token';
import { PrismaProjectInvitesRepository, ProjectInviteWithContext } from './prisma-project-invites.repository';
import { PrismaProjectInvitesMembersRepository, InviteUserState } from './prisma-project-invites-members.repository';
import { effectiveStatus, ProjectInviteRecord } from './domain/project-invite.domain';
import { CreateInviteDto } from './dto/create-invite.dto';
import { InviteCreateResultDto, InviteDto } from './dto/invite.dto';

const DAY_MS = 86_400_000;
/** Transactional notices carry no user preference, so MEMBER_ADDED is always rendered in English. */
const MEMBER_ADDED_LOCALE = 'en';

/**
 * Fleet S4b US-004: project invites. `create` either adds an existing active user directly or mints a
 * one-time invite for an unknown address (raw token returned once, hash stored); `list` reports the
 * effective status and never exposes token material.
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
  ) {}

  async create(
    slug: string,
    dto: CreateInviteDto,
    principal: KodaPrincipal,
    locale: string,
  ): Promise<InviteCreateResultDto> {
    const projectId = await this.access.findProjectIdBySlug(slug);
    await this.access.assertProjectAdmin(projectId, principal);

    const email = dto.email.trim().toLowerCase();
    const userId = await this.members.findUserIdByEmail(email);
    if (userId) return this.addExistingUser(projectId, userId, dto.role);

    return this.inviteNewAddress(projectId, email, dto.role, principal, locale);
  }

  async list(slug: string, principal: KodaPrincipal): Promise<InviteDto[]> {
    const projectId = await this.access.findProjectIdBySlug(slug);
    await this.access.assertProjectAdmin(projectId, principal);

    const now = new Date();
    const records = await this.invites.list(projectId);
    return records.map((record) => this.toDto(record, now));
  }

  /** An active account joins immediately; a disabled account (or an existing membership) is a 409. */
  private async addExistingUser(
    projectId: string,
    userId: string,
    role: ProjectMemberRole,
  ): Promise<InviteCreateResultDto> {
    const user: InviteUserState | null = await this.members.findUserState(userId);
    if (!user || user.disabled) throw new ConflictAppException({}, 'invites.userDisabled');

    let member: ProjectMemberRecord;
    try {
      member = await this.members.createMember(projectId, userId, role);
    } catch (error) {
      if (isUniqueViolation(error, 'userId')) throw new ConflictAppException({}, 'invites.memberExists');
      throw error;
    }

    // The email is a transactional notice: it never consults notification preferences.
    if (this.email.configured) {
      await this.schedule.scheduleMemberAdded({
        userId,
        projectId,
        toEmail: user.email,
        locale: MEMBER_ADDED_LOCALE,
        dueAt: new Date(),
      });
    }

    return { outcome: 'ADDED', member: ProjectMemberDto.from(member) };
  }

  private async inviteNewAddress(
    projectId: string,
    email: string,
    role: ProjectMemberRole,
    principal: KodaPrincipal,
    locale: string,
  ): Promise<InviteCreateResultDto> {
    const now = new Date();
    const { raw, hash } = generateInviteToken();
    const expiresAt = new Date(now.getTime() + this.email.config().inviteTtlDays * DAY_MS);

    // Cancel any earlier pending invite and mint the replacement in one transaction (AC-7).
    const invite = await this.txManager.run(async () => {
      await this.invites.cancelPending(projectId, email);
      return this.invites.create({
        projectId,
        email,
        role,
        tokenHash: hash,
        invitedById: principal.id,
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
        role: invite.role,
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
      status: effectiveStatus(record, now),
      inviterName: record.inviterName,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
    };
  }
}

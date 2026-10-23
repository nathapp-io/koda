import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import * as bcrypt from 'bcrypt';
import { AuthService } from '../../auth/auth.service';
import { AuthResponseDto } from '../../auth/dto/auth-response.dto';
import { UserDomain } from '../../auth/domain/auth.domain';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { isUniqueViolation } from '../../common/utils/prisma-errors';
import { MembershipService } from '../../permissions/membership.service';
import type { RoleBindingView } from '../../permissions/permissions.types';
import { hashInviteToken } from './invite-token';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { InvitePreviewDto } from './dto/invite-preview.dto';
import { PrismaProjectInvitesRepository, ProjectInvitePreview } from './prisma-project-invites.repository';
import { PrismaProjectInvitesMembersRepository } from './prisma-project-invites-members.repository';

/** Same cost as `UsersAdminService.create` and `AuthService.register` (bcrypt rounds 12). */
const BCRYPT_ROUNDS = 12;
/** Register's fallback display name when the body omits one (BUG-8: never the email local part). */
const DEFAULT_NAME = 'User';

/**
 * How acceptance names the invite's role: the persisted row when the invite has one, the legacy key a
 * pre-migration invite stands for otherwise.
 */
type InvitedRole = { roleId: string } | { roleKey: string };

/**
 * US-005 (AC-7): the role identity the invite *persisted*, never the key it displays.
 *
 * A row with a `roleId` binds that id. A pre-migration row (no `roleId`) binds the role its legacy enum
 * maps to, which the repository already resolved into `roleKey`. A row with neither names no role at all
 * — the custom role it carried was deleted before acceptance — and `null` makes the accept answer 409
 * `invites.roleGone`.
 */
function invitedRole(invite: ProjectInvitePreview): InvitedRole | null {
  if (invite.roleId !== null) return { roleId: invite.roleId };
  return invite.roleKey === null ? null : { roleKey: invite.roleKey };
}

/**
 * Fleet S4b US-005: the anonymous side of project invites. A token is single-use — the accept
 * transaction flips the invite PENDING -> ACCEPTED conditionally, so a concurrent second accept
 * updates zero rows and 404s. The session is minted only after that transaction commits.
 */
@Injectable()
export class InviteAcceptanceService {
  constructor(
    private readonly invites: PrismaProjectInvitesRepository,
    private readonly members: PrismaProjectInvitesMembersRepository,
    private readonly auth: AuthService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly membership: MembershipService,
  ) {}

  async preview(token: string): Promise<InvitePreviewDto> {
    const invite = await this.invites.findByTokenHash(hashInviteToken(token));
    if (!this.usable(invite)) throw this.notFound();

    return {
      projectName: invite.projectName,
      projectSlug: invite.projectSlug,
      email: invite.email,
      roleKey: invite.roleKey,
      roleName: invite.roleName,
      inviterName: invite.inviterName,
      expiresAt: invite.expiresAt,
    };
  }

  async accept(token: string, dto: AcceptInviteDto): Promise<AuthResponseDto> {
    // bcrypt never runs inside the transaction: the tx only covers the claim and the two writes.
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const now = new Date();

    const user = await this.membership.afterCommit(() => this.txManager.run(async () => {
      const tokenHash = hashInviteToken(token);
      const invite = await this.invites.findByTokenHash(tokenHash);
      if (!this.usable(invite, now)) throw this.notFound();

      // The role the invite names is gone (a custom role deleted after the invite was issued, which
      // clears `roleId`, and no legacy role stands in for it): nothing is granted, so nothing is claimed
      // and no account is created (AC-7).
      const roleRef = invitedRole(invite);
      if (roleRef === null) throw new ConflictAppException({}, 'invites.roleGone');

      // The single-use gate (AC-7): exactly one concurrent accept sees count 1, the other rolls back.
      // The hash is re-checked inside the claim, so a resend that rotated it in between (AC-8) leaves
      // this superseded link unredeemable rather than accepting an invite the admin replaced.
      if (!(await this.invites.claimPending(invite.id, tokenHash, now))) throw this.notFound();

      // An account created after the invite (case-insensitive) is a conflict, and the claim above
      // rolls back with it, so the invite stays PENDING (AC-9).
      if (await this.members.findUserIdByEmail(invite.email)) {
        throw new ConflictAppException({}, 'invites.accountExists');
      }

      const created = await this.createUser(invite.email, dto.name, passwordHash);
      await this.invites.setAcceptedBy(invite.id, created.id, now);
      // US-005 (AC-7): the persisted role identity binds — its id when the row has one, so a role deleted
      // and its key reused after the invite's read answers roleGone instead of granting the successor.
      if ((await this.bindInvitedRole(invite.projectId, created.id, roleRef)) === null) {
        throw new ConflictAppException({}, 'invites.roleGone');
      }
      await this.membership.bindBaseline({ type: 'USER', id: created.id });
      return created;
    }));

    // Issued after commit: a rolled-back accept never hands out a token for a user that does not exist.
    return await this.auth.issueSession(user);
  }

  /**
   * The project binding of the invited account, by the role's **id** whenever the invite persisted one:
   * resolving the key instead would let a role created under a deleted role's key after the invite's read
   * hand out permissions the invite never named. `null` means that role is gone and nothing was written;
   * the accept transaction then rolls back the claimed invite and the created account with it.
   */
  private bindInvitedRole(
    projectId: string,
    userId: string,
    role: InvitedRole,
  ): Promise<RoleBindingView | null> {
    const principal = { type: 'USER' as const, id: userId };
    const grantedBy = { type: 'SYSTEM' as const, id: 'invite' };
    return 'roleId' in role
      ? this.membership.createBindingForRole({ principal, roleId: role.roleId, projectId }, grantedBy)
      : this.membership.createBinding({ principal, roleKey: role.roleKey, projectId }, grantedBy);
  }

  private async createUser(email: string, name: string | undefined, passwordHash: string): Promise<UserDomain> {
    try {
      return await this.members.createInvitedUser({ email, name: name ?? DEFAULT_NAME, passwordHash });
    } catch (error) {
      // Two invites for the same address accepted concurrently: the loser is a conflict, not a 500.
      if (isUniqueViolation(error, 'email')) throw new ConflictAppException({}, 'invites.accountExists');
      throw error;
    }
  }

  /** A token is previewable and acceptable only while the row is PENDING and unexpired. */
  private usable(invite: ProjectInvitePreview | null, now = new Date()): invite is ProjectInvitePreview {
    return invite !== null && invite.status === 'PENDING' && invite.expiresAt.getTime() > now.getTime();
  }

  /** Unknown, expired, cancelled and accepted tokens all answer identically (AC-2). */
  private notFound(): NotFoundAppException {
    return new NotFoundAppException({}, 'invites');
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import * as bcrypt from 'bcrypt';
import { AuthService } from '../../auth/auth.service';
import { AuthResponseDto } from '../../auth/dto/auth-response.dto';
import { UserDomain } from '../../auth/domain/auth.domain';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { isUniqueViolation } from '../../common/utils/prisma-errors';
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
  ) {}

  async preview(token: string): Promise<InvitePreviewDto> {
    const invite = await this.invites.findByTokenHash(hashInviteToken(token));
    if (!this.usable(invite)) throw this.notFound();

    return {
      projectName: invite.projectName,
      projectSlug: invite.projectSlug,
      email: invite.email,
      role: invite.role,
      inviterName: invite.inviterName,
      expiresAt: invite.expiresAt,
    };
  }

  async accept(token: string, dto: AcceptInviteDto): Promise<AuthResponseDto> {
    // bcrypt never runs inside the transaction: the tx only covers the claim and the two writes.
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const now = new Date();

    const user = await this.txManager.run(async () => {
      const invite = await this.invites.findByTokenHash(hashInviteToken(token));
      if (!this.usable(invite, now)) throw this.notFound();

      // The single-use gate (AC-7): exactly one concurrent accept sees count 1, the other rolls back.
      if (!(await this.invites.claimPending(invite.id, now))) throw this.notFound();

      // An account created after the invite (case-insensitive) is a conflict, and the claim above
      // rolls back with it, so the invite stays PENDING (AC-9).
      if (await this.members.findUserIdByEmail(invite.email)) {
        throw new ConflictAppException({}, 'invites.accountExists');
      }

      const created = await this.createUser(invite.email, dto.name, passwordHash);
      await this.invites.setAcceptedBy(invite.id, created.id, now);
      await this.members.createMember(invite.projectId, created.id, invite.role);
      return created;
    });

    // Issued after commit: a rolled-back accept never hands out a token for a user that does not exist.
    return this.auth.issueSession(user);
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

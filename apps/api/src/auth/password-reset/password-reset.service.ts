import { Injectable, Logger } from '@nestjs/common';
import { CacheManager } from '@nathapp/nestjs-cache';
import { ValidationAppException } from '@nathapp/nestjs-common';
import * as bcrypt from 'bcrypt';
import { bookkeeping } from '../../action-context/audit-coverage';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { EmailAvailability } from '../../email/email-availability';
import { EmailDispatcher } from '../../email/email-dispatcher';
import { EmailScheduleService } from '../../email/schedule/email-schedule.service';
import type { EmailLocale } from '../../email/templates/template-codes';
import type { UserDomain } from '../domain/auth.domain';
import { PrismaAuthRepository } from '../prisma-auth.repository';
import { AuthSessionService } from '../sessions/auth-session.service';
import {
  authSessionCacheKey,
  userAuthStateCacheKey,
  userTokenVersionCacheTag,
  withAuthSessionCacheLock,
} from '../token-version.cache';
import type { PasswordResetConfirmDto } from '../dto/password-reset-confirm.dto';
import { PASSWORD_RESET_TTL_MS } from './password-reset.constants';
import { generatePasswordResetToken, hashPasswordResetToken } from './password-reset-token';
import { PasswordResetTokenStore } from './password-reset-token.store';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The one answer every refused confirmation gives: missing, used, expired, or a disabled account. */
const invalidToken = (): ValidationAppException => new ValidationAppException({}, 'auth.resetTokenInvalid');

/** bcrypt cost of every password this app writes, matching `AuthService`. */
const PASSWORD_HASH_ROUNDS = 12;

/**
 * auth-passwords US-003: the public reset request.
 *
 * `request` answers after the user lookup and never says whether the address has an account. The
 * token write and the email are detached: they run inside `bookkeeping('auth.password-reset-request')`
 * so the rows they write never count against the request's audit scope — the request records no audit
 * entry on purpose, and one it recorded would reveal that the address exists.
 *
 * Only the sha256 of the raw token is stored, so a failed send is final (retry is off): the user asks
 * for another link. Nothing here logs the raw token or the link.
 *
 * `confirm` (US-004) consumes one token exactly once and changes the password without signing anyone in.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly authRepo: PrismaAuthRepository,
    private readonly tokens: PasswordResetTokenStore,
    private readonly schedule: EmailScheduleService,
    private readonly dispatcher: EmailDispatcher,
    private readonly email: EmailAvailability,
    private readonly audit: AuditRecorder,
    private readonly authSessions: AuthSessionService,
    private readonly cache: CacheManager,
  ) {}

  async request(email: string, locale: EmailLocale): Promise<void> {
    const user = await this.authRepo.findUserByEmail(email.trim());
    // An unknown address, a disabled account and an installation with email off answer exactly like
    // an accepted request: nothing to send, nothing written.
    if (!user || user.disabled || !this.email.configured) return;

    // Detached on purpose: the response must not wait for the token write or the SMTP call. The task
    // catches its own failure, so no rejection escapes into an unhandled promise.
    void this.startReset(user, locale);
  }

  private async startReset(user: UserDomain, locale: EmailLocale): Promise<void> {
    try {
      await bookkeeping('auth.password-reset-request', () => this.issueReset(user, locale));
    } catch (error) {
      // The user id and the reason only: the token and the link never reach a log line.
      this.logger.warn(`password reset request for user ${user.id} failed: ${messageOf(error)}`);
    }
  }

  private async issueReset(user: UserDomain, locale: EmailLocale): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TTL_MS);
    const { raw, hash } = generatePasswordResetToken();

    // One transaction: two concurrent requests cannot leave two unused tokens for one user.
    await this.tokens.replaceUnused(user.id, hash, expiresAt);

    const row = await this.schedule.startPasswordResetSend({
      userId: user.id,
      toEmail: user.email,
      locale,
      now,
    });

    const outcome = await this.dispatcher.sendOne(
      row,
      'PASSWORD_RESET',
      { url: this.email.webUrl(`/reset-password/${raw}`), expiresAt: expiresAt.toISOString() },
      user.id,
      now,
      // Retry is off: only the hash is stored, so a retry could never present the same link again.
      false,
    );
    if (outcome !== 'SENT') {
      this.logger.warn(`password reset email for user ${user.id} ended ${outcome}`);
    }
  }

  /**
   * Consumes one emailed reset token exactly once and writes the new password. Answers `void`: no session
   * and no token pair is issued, so the client sends the user to the sign-in page (US-007).
   *
   * `usedAt` is set conditionally on it still being null, so two confirms racing the same link commit one
   * password write and one audit entry; the loser's `updateMany` answers 0 and its transaction rolls back
   * with the same 400 as a dead link. The hash is paid for before the transaction opens, so the
   * transaction never spans bcrypt.
   */
  async confirm(dto: PasswordResetConfirmDto, now: Date): Promise<void> {
    const row = await this.tokens.findByHash(hashPasswordResetToken(dto.token));
    // Missing, already used, expired, or an account disabled after the link was mailed: one answer, and
    // nothing written. The check cannot be the arbitration point — the conditional mark below is.
    if (!row || row.usedAt !== null || row.expiresAt.getTime() <= now.getTime() || row.userDisabled) {
      throw invalidToken();
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, PASSWORD_HASH_ROUNDS);

    const revoked = await this.audit.audited(async () => {
      // Lock order (branch fix B2): the user row before its reset-token rows — the same order
      // `PasswordResetTokenStore.replaceUnused` and `AuthService.changePassword` use. Marking the token
      // first inverted it, so a confirmation could hold a token row while waiting for the user row a
      // concurrent request held, which waited for the token row: Postgres aborted one of the two, and the
      // request's reset email was lost silently.
      //
      // `userDisabled` above came from the token's own read, which happened before bcrypt: an
      // administrator who finished disabling the account in the meantime is only visible under this lock
      // (branch fix B2). It is refused here, before any write, with the same 400 a dead link gets — a
      // disabled account must not be able to spend a mailed link and change its password.
      const locked = await this.authRepo.lockUser(row.userId);
      if (!locked || locked.disabled) throw invalidToken();
      const marked = await this.tokens.markUsed(row.id, now);
      if (marked === 0) throw invalidToken();
      await this.authRepo.updatePasswordHash(row.userId, passwordHash);
      await this.authRepo.bumpTokenVersion(row.userId);
      // Every session of the user ends here: a reset means the old devices are not trusted any more.
      const revokedIds = await this.authSessions.revokeAllForUser(row.userId, 'password-reset', now);
      // The user's other outstanding links die with this one, in the same transaction as the password.
      await this.tokens.discardUnusedFor(row.userId);
      return revokedIds;
    }, () => ({
      key: 'session.password.reset.confirm',
      resourceType: 'user',
      resourceId: row.userId,
      projectId: null,
      summary: 'password reset',
    }));

    // After the commit: the cached activity of each revoked session, the tagged tokenVersion state and the
    // 60 s auth state are the three answers a replayed access token could still read (the logout pattern).
    await this.evictSessions(revoked);
    await this.evict(`the token-version tag of user ${row.userId}`, () =>
      this.cache.invalidate(userTokenVersionCacheTag(row.userId), { mode: 'tag' }));
    await this.evict(`the auth state of user ${row.userId}`, () =>
      this.cache.invalidate(userAuthStateCacheKey(row.userId)));
  }

  private async evictSessions(sessionIds: readonly string[]): Promise<void> {
    for (const id of sessionIds) {
      await this.evict(`the cached activity of session ${id}`, () =>
        withAuthSessionCacheLock(id, () => this.cache.invalidate(authSessionCacheKey(id))));
    }
  }

  /**
   * Best effort: the reset has committed, so a cache failure must not answer an error the client would
   * read as "the reset failed" — it would retry a link that is already spent. The revocation itself is
   * the fence: a stale activity answer still resolves to `active: false` on the next store read.
   */
  private async evict(label: string, task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch (error) {
      this.logger.warn(`failed to evict ${label} after a password reset: ${messageOf(error)}`);
    }
  }
}

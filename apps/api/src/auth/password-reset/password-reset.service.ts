import { Injectable, Logger } from '@nestjs/common';
import { bookkeeping } from '../../action-context/audit-coverage';
import { EmailAvailability } from '../../email/email-availability';
import { EmailDispatcher } from '../../email/email-dispatcher';
import { EmailScheduleService } from '../../email/schedule/email-schedule.service';
import type { EmailLocale } from '../../email/templates/template-codes';
import type { UserDomain } from '../domain/auth.domain';
import { PrismaAuthRepository } from '../prisma-auth.repository';
import { PASSWORD_RESET_TTL_MS } from './password-reset.constants';
import { generatePasswordResetToken } from './password-reset-token';
import { PasswordResetTokenStore } from './password-reset-token.store';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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
}

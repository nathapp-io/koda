import { Inject, Injectable, Logger } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { bookkeeping } from '../../action-context/audit-coverage';
import { PrismaAuthSessionRepository } from './prisma-auth-session.repository';
import type { SessionRevokeReason } from './auth-session.domain';

/**
 * auth-sessions US-001 — the session store's public face: start a session, rotate a refresh token.
 *
 * Both operations write rows no audit entry covers (`AuthSession`, `RefreshToken`), so each runs inside
 * `bookkeeping(...)`: the audit-coverage rule ("wrote nothing it counts, or recorded at least one entry")
 * then accepts login and refresh. `revoke` and `isActive` (US-003) are the other two operations: the
 * revoke is deliberately wrapper-free, because its caller records `session.logout` in the same
 * transaction, and the activity check is a plain read. This module serves no user-facing string, so it
 * adds no i18n file.
 */

/**
 * How long a presented refresh token keeps rotating instead of revoking its session.
 *
 * The web client refreshes in parallel: every request that gets a 401 retries once, so one page load can
 * present the same token several times, and two tabs share one cookie. Without this window a normal page
 * load would log the user out. The cost is documented in the feature spec: a replay inside the window
 * rotates into a second chain of the same session instead of revoking it.
 */
export const REFRESH_REUSE_GRACE_MS = 30_000;

/**
 * How long after a token's use a lost response may still be recovered (rotation step 5).
 *
 * A browser that lost a refresh response keeps its previous access cookie, and refreshes again at the
 * latest when that access token expires (15 minutes). 20 minutes covers that with margin; past it a
 * re-presented token is revoked as reuse, so a stolen token cannot re-rotate an idle session at any time.
 */
export const LOST_RESPONSE_WINDOW_MS = 20 * 60_000;

export type { SessionRevokeReason };

export type RotateOutcome =
  | { kind: 'rotated' }
  /** Rotation step 5: a lost response was recovered. The caller answers the pair and audits the recovery. */
  | { kind: 'recovered' }
  | { kind: 'reused'; userId: string }
  | { kind: 'invalid' };

@Injectable()
export class AuthSessionService {
  private readonly logger = new Logger(AuthSessionService.name);

  constructor(
    private readonly sessions: PrismaAuthSessionRepository,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  /** Writes the session of a sign-in and its first refresh token, together. */
  async start(input: { userId: string; sessionId: string; tokenId: string; expiresAt: Date }): Promise<void> {
    await bookkeeping('auth.session-start', () =>
      this.txManager.run(async () => {
        await this.sessions.createSession({ id: input.sessionId, userId: input.userId, expiresAt: input.expiresAt });
        await this.sessions.createToken({ id: input.tokenId, sessionId: input.sessionId });
      }),
    );
  }

  /**
   * Presents a refresh token and issues the next one, in one transaction.
   *
   * The steps run in this order (spec "Rotation"):
   * 1. slide the session's expiry, conditionally on it being live — a revoked or expired session answers
   *    `invalid` with nothing written, and a concurrent logout cannot be overtaken by a committed token;
   * 2. mark the presented token used, conditionally on it being unused — the affected count decides
   *    whether this rotation is the first to present it;
   * 3. first use: insert the next token and drop the tokens used before the grace window;
   * 4. second use inside the grace window (a parallel refresh of the same browser): insert the next
   *    token and keep the session — both responses then hold a refresh token that works;
   * 5. used before the grace window but within LOST_RESPONSE_WINDOW_MS of its first use, and no token of
   *    the session was used after it: the response that carried its successor never reached the client (a
   *    navigation or a closed tab aborted the refresh after the API committed it), so the client presents
   *    the newest token it holds again. Drop the undelivered successors (unused tokens older than the grace
   *    window; a sibling a parallel retry just issued stays) and insert the next. `usedAt` is not moved, so
   *    replays cannot slide the window. A thief replaying it instead is caught one step later (the real
   *    holder's successor is gone, so presenting it hits step 6) or once the window has passed;
   * 6. otherwise (a later token was used, or no row at all): revoke the session as `reuse`.
   */
  async rotate(input: {
    sessionId: string;
    presentedTokenId: string;
    nextTokenId: string;
    nextExpiresAt: Date;
    now: Date;
  }): Promise<RotateOutcome> {
    return await bookkeeping('auth.session-rotate', () =>
      this.txManager.run(async (): Promise<RotateOutcome> => {
        const live = await this.sessions.slideExpiry(input.sessionId, input.nextExpiresAt, input.now);
        if (!live) return { kind: 'invalid' };

        const marked = await this.sessions.markUsed(input.sessionId, input.presentedTokenId, input.now);
        if (marked === 1) {
          await this.sessions.createToken({
            id: input.nextTokenId,
            sessionId: input.sessionId,
            createdAt: input.now,
          });
          await this.sessions.deleteUsedTokensBefore(
            input.sessionId,
            new Date(input.now.getTime() - REFRESH_REUSE_GRACE_MS),
          );
          return { kind: 'rotated' };
        }

        // A parallel refresh of the same browser: the token was used within the grace window.
        const presented = await this.sessions.findToken(input.presentedTokenId, input.sessionId);
        const usedWithinGrace =
          presented !== null &&
          presented.usedAt !== null &&
          presented.usedAt.getTime() >= input.now.getTime() - REFRESH_REUSE_GRACE_MS;
        if (usedWithinGrace) {
          await this.sessions.createToken({
            id: input.nextTokenId,
            sessionId: input.sessionId,
            createdAt: input.now,
          });
          return { kind: 'rotated' };
        }

        // A lost response: nothing after this token was ever used (step 5).
        if (presented !== null && presented.usedAt !== null
          && presented.usedAt.getTime() >= input.now.getTime() - LOST_RESPONSE_WINDOW_MS
          && !(await this.sessions.hasTokenUsedAfter(input.sessionId, presented.usedAt, input.presentedTokenId))) {
          await this.sessions.deleteUnusedTokens(
            input.sessionId,
            new Date(input.now.getTime() - REFRESH_REUSE_GRACE_MS),
          );
          await this.sessions.createToken({
            id: input.nextTokenId,
            sessionId: input.sessionId,
            createdAt: input.now,
          });
          // Observable on purpose: a thief replaying a stolen newest token takes this path too. The caller
          // also records a `session.refresh` audit entry for it.
          this.logger.warn(`refresh session ${input.sessionId}: lost-response recovery re-rotated a used token`);
          return { kind: 'recovered' };
        }

        // The revocation returns normally, so it commits; the caller records `session.refresh` itself.
        const userId = await this.sessions.revokeSession(input.sessionId, 'reuse', input.now);
        return userId === null ? { kind: 'invalid' } : { kind: 'reused', userId };
      }),
    );
  }

  /**
   * Ends one session, if it belongs to `userId` and has not already ended.
   *
   * No transaction of its own and no audit entry: the caller (logout) runs this inside the
   * `audited(...)` transaction that records `session.logout`, so the revoke and the entry commit or roll
   * back together. Answering false is not a failure — logging out an already-ended session, or a
   * session another user owns, writes nothing and still records the logout.
   */
  async revoke(sessionId: string, userId: string, reason: SessionRevokeReason, now: Date): Promise<boolean> {
    return await this.sessions.revokeOwnedSession(sessionId, userId, reason, now);
  }

  /** Whether a session is still live at `now` — the check `JwtAuthProvider` makes on every access token. */
  async isActive(sessionId: string, now: Date): Promise<boolean> {
    return await this.sessions.isSessionActive(sessionId, now);
  }
}

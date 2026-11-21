import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { JwtStrategyProvider, JwtRefreshStrategyProvider } from '@nathapp/nestjs-auth';
import { AuthException, ForbiddenAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { CacheManager } from '@nathapp/nestjs-cache';
import * as bcrypt from 'bcrypt';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { isUserPrincipal, type KodaPrincipal } from './principal/koda-principal.types';
import type { IPrincipal } from './types';
import { AuthResponseDto, UserResponseDto } from './dto/auth-response.dto';
import { PrismaAuthRepository } from './prisma-auth.repository';
import type { KodaUserRole } from './principal/koda-principal.types';
import { UserDomain } from './domain/auth.domain';
import { authSessionCacheKey, userAuthStateCacheKey, userTokenVersionCacheTag, withAuthSessionCacheLock } from './token-version.cache';
import { AUTH_CFG, IAuthConfig } from '../config/auth.config';
import { MembershipService } from '../permissions/membership.service';
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import { isUniqueViolation } from '../common/utils/prisma-errors';
import { AuthSessionService } from './sessions/auth-session.service';
import type { RefreshClient } from './sessions/refresh-client';
import { PasswordResetTokenStore } from './password-reset/password-reset-token.store';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  tokenVersion: number;
  sid: string;
}

// BUG-12: same-cost bcrypt hash compared against when the email is unknown,
// so unregistered-email logins take as long as registered ones.
// The value itself is never used for authentication.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('koda-timing-equalizer', 12);

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private authRepo: PrismaAuthRepository,
    private jwtStrategyProvider: JwtStrategyProvider,
    private jwtRefreshStrategyProvider: JwtRefreshStrategyProvider,
    private cache: CacheManager,
    @Inject(AUTH_CFG) private readonly authConfig: IAuthConfig,
    private readonly membership: MembershipService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly audit: AuditRecorder,
    private readonly authSessions: AuthSessionService,
    private readonly passwordResetTokens: PasswordResetTokenStore,
  ) {}

  async register(registerDto: RegisterDto) {
    const { password } = registerDto;
    // Emails are canonicalised to lower-case on write; lookups are
    // case-insensitive so rows created before normalization still resolve.
    const email = registerDto.email.trim().toLowerCase();
    // BUG-8: never leak the email local-part into the display name
    const name = registerDto.name ?? 'User';
    const allowWhenUsersExist = this.authConfig.registrationEnabled;

    // Both bootstrap gates need the same fact — whether the users table is empty — so it is read once.
    // The owner rule (permissions P1a, US-004) only applies while the seat is free; the closed-
    // registration gate only refuses when it is taken.
    const ownerEmail = this.authConfig.ownerEmail;
    const anyUser = ownerEmail !== undefined || !allowWhenUsersExist
      ? await this.authRepo.findAnyUser()
      : null;

    // Permissions P1a (US-004): when the installation names its Owner, only that email may take the
    // first registration. Refused before the create (and before bcrypt), so a refused attempt leaves
    // the users table empty; the repository's locked check stays authoritative for the empty-table race.
    if (ownerEmail !== undefined && email !== ownerEmail && anyUser === null) {
      throw new ForbiddenAppException({}, 'registration');
    }

    // Fast path: refuse before paying for bcrypt. The locked check in the
    // repository stays authoritative for the empty-table race.
    if (!allowWhenUsersExist && anyUser !== null) {
      throw new ForbiddenAppException({}, 'registration');
    }

    // A legacy mixed-case row does not collide with the plain unique index,
    // so an explicit case-insensitive check is needed when registration is open.
    if (allowWhenUsersExist && (await this.authRepo.findUserByEmail(email))) {
      throw new ConflictAppException({}, 'auth');
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // The user row and the bindings it must never be missing are one unit (B4): a committed user whose
    // Owner or baseline binding failed would answer an error, leave the Owner seat taken, and leave an
    // installation with an Owner nobody holds. The session is issued after the commit, so a rolled-back
    // registration never hands out a token for a user that does not exist.
    const created = await this.membership.afterCommit(() =>
      this.txManager.run(async () => {
        const outcome = await this.authRepo
          .findAnyUserAndCreate({ email, name, passwordHash }, { allowWhenUsersExist })
          .catch((error: unknown) => {
            if (isUniqueViolation(error, 'email')) throw new ConflictAppException({}, 'auth');
            throw error;
          });
        if (!outcome) return null;

        // The first user gets the installation's Owner binding; everyone else starts at the member
        // baseline. The hooks run before the session is issued.
        await this.membership.bindOwnerIfFirst(outcome.user.id, outcome.firstUser);
        await this.membership.bindBaseline({ type: 'USER', id: outcome.user.id });
        await this.audit.record({
          key: 'auth.register', resourceType: 'user', resourceId: outcome.user.id,
          projectId: null, summary: 'registered',
        });
        return outcome.user;
      }),
    );
    if (!created) {
      throw new ForbiddenAppException({}, 'registration');
    }

    // Owner binding creation can bump tokenVersion inside the transaction.
    const user = await this.authRepo.findUserById(created.id);
    if (!user || user.disabled) throw new AuthException({}, 'auth');
    return this.issueSession(user);
  }

  async registrationStatus(): Promise<{ open: boolean }> {
    if (this.authConfig.registrationEnabled) return { open: true };
    return { open: (await this.authRepo.findAnyUser()) === null };
  }

  async login(loginDto: LoginDto) {
    const { email, password } = loginDto;

    const user = await this.authRepo.findUserByEmail(email);

    if (!user) {
      // BUG-12: burn the same bcrypt CPU as a real login so response
      // timing cannot enumerate registered emails.
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      throw new AuthException({}, 'auth.invalidCredentials');
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    // A disabled account answers exactly like a wrong password (no enumeration).
    if (!isPasswordValid || user.disabled) {
      throw new AuthException({}, 'auth.invalidCredentials');
    }

    // Branch fix B1: the hash proved above must still be the account's password at the moment the session
    // is written, read under the user row lock every password write takes. A change that commits while
    // this request is hashing therefore refuses this sign-in — 401, like a wrong password — instead of
    // handing out a session its bulk revocation has already run past; and a change that arrives later
    // waits for the session, then revokes it. Without the fence the new session would refresh for good,
    // because a password change leaves `tokenVersion` alone.
    const verifiedHash = user.passwordHash;
    return this.issueSession(user, async () => {
      const locked = await this.authRepo.lockUser(user.id);
      return locked !== null && !locked.disabled && locked.passwordHash === verifiedHash;
    });
  }

  async refresh(principal: IPrincipal, client: RefreshClient) {
    // H1: the refresh strategy flags tokens issued before a logout
    // (tokenVersion < current). Never mint a new pair from those.
    if (principal.revoked) {
      throw new AuthException({}, 'auth');
    }

    // A pair this feature issues names both its session and its own token row. A token carrying neither
    // claim predates sessions, and one carrying only one of them is not a pair this service minted: both
    // are refused before any write rather than guessed at, so every user signs in once after the deploy.
    const sessionId = principal.extra?.['sessionId'];
    const tokenId = principal.extra?.['tokenId'];
    if (typeof sessionId !== 'string' || typeof tokenId !== 'string') {
      throw new AuthException({}, 'auth');
    }

    // JwtRefreshStrategy returns IPrincipal (with .id), not JwtPayload (with .sub)
    const user = await this.authRepo.findUserById(principal.id);

    if (!user || user.disabled) {
      throw new AuthException({}, 'auth');
    }

    // auth-sessions US-003/4: the session is continued, not replaced, and the store's conditional
    // rotation is the fence against logout. `rotate` slides a live session and marks the presented token
    // used in one transaction, so it either loses to a concurrent revoke — and this call then answers 401
    // with nothing written — or it wins and the pair it authorises belongs to the very session the logout
    // revokes next. A standalone liveness read could not give that guarantee.
    const role = await this.roleClaim(user.id);
    const nextTokenId = randomUUID();
    const refreshToken = this.generateRefreshToken(user.id, user.tokenVersion, sessionId, nextTokenId);
    const accessToken = this.generateAccessToken(user.id, user.email, role, user.tokenVersion, sessionId);

    const outcome = await this.authSessions.rotate({
      sessionId,
      presentedTokenId: tokenId,
      nextTokenId,
      nextExpiresAt: this.refreshExpiryOf(refreshToken),
      now: new Date(),
      // auth-passwords US-005: the first use binds the token to this client, and a recovery must match it.
      client,
    });

    // The session ended (a logout, an expiry): mint nothing and record nothing — a dead session is not
    // evidence of theft.
    if (outcome.kind === 'invalid') {
      throw new AuthException({}, 'auth');
    }

    if (outcome.kind === 'reused') {
      // The presented token was already spent: the session is revoked by now, so the cached activity
      // answer must not outlive it, and the theft goes on the record after that revocation has committed.
      // The eviction takes the session's cache lock, so a lookup that read the store before this revoke
      // cannot repopulate the key after it (see `withAuthSessionCacheLock`).
      await withAuthSessionCacheLock(sessionId, () => this.cache.invalidate(authSessionCacheKey(sessionId)));
      await this.recordRefreshEvent(outcome.userId, 'refresh token reuse; session revoked');
      throw new AuthException({}, 'auth');
    }

    if (outcome.kind === 'recovered') {
      // A lost response was recovered (rotation step 5). A thief replaying a stolen newest token inside
      // the window takes the same path, so the recovery goes on the record next to the reuse revocations,
      // naming the IP it came from (US-005: the recovery is the one refresh outcome worth chasing).
      await this.recordRefreshEvent(
        user.id,
        `refresh token lost-response recovery; session kept; ip ${outcome.ip ?? 'unknown'}`,
      );
    }

    return { accessToken, refreshToken, user: UserResponseDto.from(user, role) };
  }

  /**
   * Records a `session.refresh` entry for what `AuthSessionService.rotate` has already committed: a reuse
   * revocation, or a lost-response recovery.
   *
   * `AuditRecorder.record` must run inside a transaction and the rotation's own is closed, so this opens
   * one of its own. A failed write is logged and swallowed: the rotation's outcome stands either way, and
   * the caller's answer (401 for a reuse, the new pair for a recovery) must not become a 500 about its
   * bookkeeping.
   */
  private async recordRefreshEvent(userId: string, summary: string): Promise<void> {
    try {
      await this.txManager.run(() => this.audit.record({
        key: 'session.refresh',
        resourceType: 'user',
        resourceId: userId,
        projectId: null,
        summary,
      }));
    } catch (error) {
      this.logger.warn(`failed to record session.refresh (${summary}) for user ${userId}: ${String(error)}`);
    }
  }

  /** Display/compatibility claim only; authorization uses permission keys. */
  async roleClaim(userId: string): Promise<KodaUserRole> {
    return (await this.membership.isGlobalAdmin(userId)) ? 'ADMIN' : 'MEMBER';
  }

  async userResponse(user: UserDomain): Promise<UserResponseDto> {
    return UserResponseDto.from(user, await this.roleClaim(user.id));
  }

  /**
   * The session shape shared by register, login, refresh and invite acceptance.
   *
   * `fence` (branch fix B1) is a credential re-check that `AuthSessionService.start` runs inside the
   * session's own transaction, before the rows are written: a sign-in it refuses writes no session and
   * answers like a wrong password.
   */
  async issueSession(user: UserDomain, fence?: () => Promise<boolean>): Promise<AuthResponseDto> {
    // Derive once so the JWT and response describe the same binding snapshot.
    const role = await this.roleClaim(user.id);
    const response = UserResponseDto.from(user, role);
    const sessionId = randomUUID();
    const tokenId = randomUUID();
    const refreshToken = this.generateRefreshToken(user.id, user.tokenVersion, sessionId, tokenId);
    const accessToken = this.generateAccessToken(user.id, user.email, role, user.tokenVersion, sessionId);
    const started = await this.authSessions.start({
      userId: user.id,
      sessionId,
      tokenId,
      expiresAt: this.refreshExpiryOf(refreshToken),
    }, fence);
    if (!started) throw new AuthException({}, 'auth');
    return { accessToken, refreshToken, user: response };
  }

  /** The `exp` of a signed refresh token, as the session expiry both start and rotate persist. */
  private refreshExpiryOf(refreshToken: string): Date {
    const claims = JSON.parse(Buffer.from(refreshToken.split('.')[1] ?? '', 'base64url').toString()) as { exp?: number };
    if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
      throw new Error('Signed refresh token did not contain a valid exp claim');
    }
    return new Date(claims.exp * 1000);
  }

  async changePassword(principal: KodaPrincipal, dto: ChangePasswordDto): Promise<void> {
    if (!isUserPrincipal(principal) || !principal.sessionId) throw new AuthException({}, 'auth');
    const sessionId = principal.sessionId;
    const user = await this.authRepo.findUserById(principal.id);
    if (!user || user.disabled) throw new AuthException({}, 'auth');
    if (!(await bcrypt.compare(dto.currentPassword, user.passwordHash))) {
      throw new ForbiddenAppException({}, 'auth.currentPasswordWrong');
    }
    // The hash the compare above proved. The transaction only writes while it is still the stored one,
    // so two changes racing the same correct `currentPassword` cannot both win (branch fix B1).
    const verifiedHash = user.passwordHash;
    const hash = await bcrypt.hash(dto.newPassword, 12);
    const now = new Date();
    const revoked = await this.audit.audited(async () => {
      // User row first, then the rows that hang off it — the lock order `PasswordResetService.confirm`
      // and the reset request use too (branch fix B2), so a concurrent confirmation cannot deadlock
      // against this transaction. Under READ COMMITTED the lock also re-reads the row: another change
      // that committed while this request was hashing is visible in `locked`, and one still in flight
      // waits behind it.
      const locked = await this.authRepo.lockUser(user.id);
      // The account as the lock sees it, not as the checks above saw it (branch fix B2): an administrative
      // disable commits its own update on this row, so one that finished while this request was verifying
      // or hashing is visible here and only here. It answers like the refusal above the transaction — 401,
      // nothing written — instead of letting a disabled account change its own password.
      if (!locked || locked.disabled) throw new AuthException({}, 'auth');
      // A concurrent change of the same user committed first, so the `currentPassword` this request
      // verified is no longer the account's password: answer the same 403 a wrong current password gets
      // and write nothing, instead of overwriting the change that won.
      if (locked.passwordHash !== verifiedHash) {
        throw new ForbiddenAppException({}, 'auth.currentPasswordWrong');
      }
      // Revalidated under the lock as well: a change that won revokes every other session of the user, so
      // this caller's session may already be gone. A stale request ends here with nothing written.
      if (!(await this.authSessions.isActive(sessionId, now))) throw new AuthException({}, 'auth');
      await this.authRepo.updatePasswordHash(user.id, hash);
      const revokedIds = await this.authSessions.revokeAllForUser(user.id, 'password-change', now, sessionId);
      // auth-passwords US-003: a reset link emailed before this change stops working, in the same
      // transaction, so the password write and the link invalidation commit or roll back together.
      await this.passwordResetTokens.discardUnusedFor(user.id);
      return revokedIds;
    }, () => ({ key: 'session.password.change', resourceType: 'user', resourceId: user.id, projectId: null, summary: 'password changed' }));
    for (const id of revoked) {
      await withAuthSessionCacheLock(id, () => this.cache.invalidate(authSessionCacheKey(id)));
    }
    await this.cache.invalidate(userAuthStateCacheKey(user.id));
  }

  async validateUser(principal: IPrincipal) {
    const user = await this.authRepo.findUserById(principal.id);

    return user || null;
  }

  /**
   * Ends the caller's session, or — for a token issued before sessions — every session of the user.
   *
   * With a `sessionId` (auth-sessions US-003) the revoke is the audited work, so the session row and the
   * `session.logout` entry commit or roll back together, and `tokenVersion` is untouched: logging out one
   * device must leave the others signed in. A revoke that matches nothing (already ended, or a session
   * another user owns) is not an error — the request still answers 200 and still records the entry.
   *
   * Without one (a legacy access token, or an agent principal) the `tokenVersion` bump stays as before,
   * together with the user-cache evictions the bump needs.
   */
  async logout(userId: string, sessionId?: string): Promise<void> {
    if (sessionId !== undefined) {
      await this.audit.audited(
        () => this.authSessions.revoke(sessionId, userId, 'logout', new Date()),
        () => ({
          key: 'session.logout',
          resourceType: 'user',
          resourceId: userId,
          projectId: null,
          summary: 'logged out',
        }),
      );
      // The activity answer is cached for 60 s as an object; evict it by its direct key, because the
      // MEMORY strategy has no tag registry (see the note below) and would never match a tag. The
      // eviction takes the session's cache lock, so a lookup that read the store before this revoke
      // cannot repopulate the key after it (see `withAuthSessionCacheLock`).
      await withAuthSessionCacheLock(sessionId, () => this.cache.invalidate(authSessionCacheKey(sessionId)));
      return;
    }

    await this.audit.audited(
      () => this.authRepo.bumpTokenVersion(userId),
      () => ({
        key: 'session.logout',
        resourceType: 'user',
        resourceId: userId,
        projectId: null,
        summary: 'logged out',
      }),
    );
    await this.cache.invalidate(userTokenVersionCacheTag(userId), { mode: 'tag' });
    // MEMORY strategy has no tag registry, so tag mode degrades to deleting the
    // literal `USER:<id>` key and never matches `USER-AUTH-STATE:<id>`. Evict
    // the cached 60 s auth state by its direct key as well.
    await this.cache.invalidate(userAuthStateCacheKey(userId));
  }

  generateAccessToken(userId: string, email: string, role: string, tokenVersion: number, sessionId: string): string {
    const payload: JwtPayload = { sub: userId, email, role, tokenVersion, sid: sessionId };
    return this.jwtStrategyProvider.sign(payload);
  }

  generateRefreshToken(userId: string, tokenVersion: number, sessionId: string, tokenId: string): string {
    return this.jwtRefreshStrategyProvider.sign({ sub: userId, tokenVersion, sid: sessionId, jti: tokenId });
  }
}

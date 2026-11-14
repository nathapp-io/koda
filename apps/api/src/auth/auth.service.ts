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
import type { IPrincipal } from './types';
import { AuthResponseDto, UserResponseDto } from './dto/auth-response.dto';
import { PrismaAuthRepository } from './prisma-auth.repository';
import type { KodaUserRole } from './principal/koda-principal.types';
import { UserDomain } from './domain/auth.domain';
import { authSessionCacheKey, userAuthStateCacheKey, userTokenVersionCacheTag } from './token-version.cache';
import { AUTH_CFG, IAuthConfig } from '../config/auth.config';
import { MembershipService } from '../permissions/membership.service';
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import { isUniqueViolation } from '../common/utils/prisma-errors';
import { AuthSessionService } from './sessions/auth-session.service';

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
      throw new AuthException({}, 'auth');
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    // A disabled account answers exactly like a wrong password (no enumeration).
    if (!isPasswordValid || user.disabled) {
      throw new AuthException({}, 'auth');
    }

    return this.issueSession(user);
  }

  async refresh(principal: IPrincipal) {
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
    });

    // The session ended (a logout, an expiry): mint nothing and record nothing — a dead session is not
    // evidence of theft.
    if (outcome.kind === 'invalid') {
      throw new AuthException({}, 'auth');
    }

    if (outcome.kind === 'reused') {
      // The presented token was already spent: the session is revoked by now, so the cached activity
      // answer must not outlive it, and the theft goes on the record after that revocation has committed.
      await this.cache.invalidate(authSessionCacheKey(sessionId));
      await this.recordRefreshReuse(outcome.userId);
      throw new AuthException({}, 'auth');
    }

    return { accessToken, refreshToken, user: UserResponseDto.from(user, role) };
  }

  /**
   * Records the reuse revocation `AuthSessionService.rotate` has already committed.
   *
   * `AuditRecorder.record` must run inside a transaction and the rotation's own is closed, so this opens
   * one of its own. A failed write is logged and swallowed: the session is revoked either way, and the
   * caller's answer must stay the 401 that revocation earned, not a 500 about its bookkeeping.
   */
  private async recordRefreshReuse(userId: string): Promise<void> {
    try {
      await this.txManager.run(() => this.audit.record({
        key: 'session.refresh',
        resourceType: 'user',
        resourceId: userId,
        projectId: null,
        summary: 'refresh token reuse; session revoked',
      }));
    } catch (error) {
      this.logger.warn(`failed to record session.refresh for reused token of user ${userId}: ${String(error)}`);
    }
  }

  /** Display/compatibility claim only; authorization uses permission keys. */
  async roleClaim(userId: string): Promise<KodaUserRole> {
    return (await this.membership.isGlobalAdmin(userId)) ? 'ADMIN' : 'MEMBER';
  }

  async userResponse(user: UserDomain): Promise<UserResponseDto> {
    return UserResponseDto.from(user, await this.roleClaim(user.id));
  }

  /** The session shape shared by register, login, refresh and invite acceptance. */
  async issueSession(user: UserDomain): Promise<AuthResponseDto> {
    // Derive once so the JWT and response describe the same binding snapshot.
    const role = await this.roleClaim(user.id);
    const response = UserResponseDto.from(user, role);
    const sessionId = randomUUID();
    const tokenId = randomUUID();
    const refreshToken = this.generateRefreshToken(user.id, user.tokenVersion, sessionId, tokenId);
    const accessToken = this.generateAccessToken(user.id, user.email, role, user.tokenVersion, sessionId);
    await this.authSessions.start({
      userId: user.id,
      sessionId,
      tokenId,
      expiresAt: this.refreshExpiryOf(refreshToken),
    });
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
      // MEMORY strategy has no tag registry (see the note below) and would never match a tag.
      await this.cache.invalidate(authSessionCacheKey(sessionId));
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

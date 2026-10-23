import { Inject, Injectable } from '@nestjs/common';
import { JwtStrategyProvider, JwtRefreshStrategyProvider } from '@nathapp/nestjs-auth';
import { AuthException, ForbiddenAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { CacheManager } from '@nathapp/nestjs-cache';
import * as bcrypt from 'bcrypt';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import type { IPrincipal } from './types';
import { AuthResponseDto, UserResponseDto } from './dto/auth-response.dto';
import { PrismaAuthRepository } from './prisma-auth.repository';
import type { KodaUserRole } from './principal/koda-principal.types';
import { UserDomain } from './domain/auth.domain';
import { userAuthStateCacheKey, userTokenVersionCacheTag } from './token-version.cache';
import { AUTH_CFG, IAuthConfig } from '../config/auth.config';
import { MembershipService } from '../permissions/membership.service';
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import { isUniqueViolation } from '../common/utils/prisma-errors';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  tokenVersion: number;
}

// BUG-12: same-cost bcrypt hash compared against when the email is unknown,
// so unregistered-email logins take as long as registered ones.
// The value itself is never used for authentication.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('koda-timing-equalizer', 12);

@Injectable()
export class AuthService {
  constructor(
    private authRepo: PrismaAuthRepository,
    private jwtStrategyProvider: JwtStrategyProvider,
    private jwtRefreshStrategyProvider: JwtRefreshStrategyProvider,
    private cache: CacheManager,
    @Inject(AUTH_CFG) private readonly authConfig: IAuthConfig,
    private readonly membership: MembershipService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
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
    // JwtRefreshStrategy returns IPrincipal (with .id), not JwtPayload (with .sub)
    const user = await this.authRepo.findUserById(principal.id);

    if (!user || user.disabled) {
      throw new AuthException({}, 'auth');
    }

    return this.issueSession(user);
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
    // Resolve both reads before signing anything: either can fail closed.
    const [role, response] = await Promise.all([this.roleClaim(user.id), this.userResponse(user)]);
    return {
      accessToken: this.generateAccessToken(user.id, user.email, role, user.tokenVersion),
      refreshToken: this.generateRefreshToken(user.id, user.tokenVersion),
      user: response,
    };
  }

  async validateUser(principal: IPrincipal) {
    const user = await this.authRepo.findUserById(principal.id);

    return user || null;
  }

  async logout(userId: string): Promise<void> {
    await this.authRepo.bumpTokenVersion(userId);
    await this.cache.invalidate(userTokenVersionCacheTag(userId), { mode: 'tag' });
    // MEMORY strategy has no tag registry, so tag mode degrades to deleting the
    // literal `USER:<id>` key and never matches `USER-AUTH-STATE:<id>`. Evict
    // the cached 60 s auth state by its direct key as well.
    await this.cache.invalidate(userAuthStateCacheKey(userId));
  }

  generateAccessToken(userId: string, email: string, role: string, tokenVersion: number): string {
    const payload: JwtPayload = { sub: userId, email, role, tokenVersion };
    return this.jwtStrategyProvider.sign(payload);
  }

  generateRefreshToken(userId: string, tokenVersion: number): string {
    return this.jwtRefreshStrategyProvider.sign({ sub: userId, tokenVersion });
  }
}

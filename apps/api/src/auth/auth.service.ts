import { Inject, Injectable } from '@nestjs/common';
import { JwtStrategyProvider, JwtRefreshStrategyProvider } from '@nathapp/nestjs-auth';
import { AuthException, ForbiddenAppException } from '@nathapp/nestjs-common';
import { CacheManager } from '@nathapp/nestjs-cache';
import * as bcrypt from 'bcrypt';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import type { IPrincipal } from './types';
import { UserResponseDto } from './dto/auth-response.dto';
import { PrismaAuthRepository } from './prisma-auth.repository';
import { userTokenVersionCacheTag } from './token-version.cache';
import { AUTH_CFG, IAuthConfig } from '../config/auth.config';

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
  ) {}

  async register(registerDto: RegisterDto) {
    const { email, password } = registerDto;
    // BUG-8: never leak the email local-part into the display name
    const name = registerDto.name ?? 'User';
    const allowWhenUsersExist = this.authConfig.registrationEnabled;

    // Fast path: refuse before paying for bcrypt. The locked check in the
    // repository stays authoritative for the empty-table race.
    if (!allowWhenUsersExist && (await this.authRepo.findAnyUser()) !== null) {
      throw new ForbiddenAppException({}, 'registration');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const created = await this.authRepo.findAnyUserAndCreate(
      { email, name, passwordHash },
      { allowWhenUsersExist },
    );
    if (!created) {
      throw new ForbiddenAppException({}, 'registration');
    }
    const { user } = created;

    const accessToken = this.generateAccessToken(user.id, user.email, user.role, user.tokenVersion);
    const refreshToken = this.generateRefreshToken(user.id, user.tokenVersion);

    return {
      accessToken,
      refreshToken,
      user: UserResponseDto.from(user),
    };
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
    if (!isPasswordValid) {
      throw new AuthException({}, 'auth');
    }

    const accessToken = this.generateAccessToken(user.id, user.email, user.role, user.tokenVersion);
    const refreshToken = this.generateRefreshToken(user.id, user.tokenVersion);

    return {
      accessToken,
      refreshToken,
      user: UserResponseDto.from(user),
    };
  }

  async refresh(principal: IPrincipal) {
    // H1: the refresh strategy flags tokens issued before a logout
    // (tokenVersion < current). Never mint a new pair from those.
    if (principal.revoked) {
      throw new AuthException({}, 'auth');
    }
    // JwtRefreshStrategy returns IPrincipal (with .id), not JwtPayload (with .sub)
    const user = await this.authRepo.findUserById(principal.id);

    if (!user) {
      throw new AuthException({}, 'auth');
    }

    const accessToken = this.generateAccessToken(user.id, user.email, user.role, user.tokenVersion);
    const refreshToken = this.generateRefreshToken(user.id, user.tokenVersion);

    return {
      accessToken,
      refreshToken,
      user: UserResponseDto.from(user),
    };
  }

  async validateUser(principal: IPrincipal) {
    const user = await this.authRepo.findUserById(principal.id);

    return user || null;
  }

  async logout(userId: string): Promise<void> {
    await this.authRepo.bumpTokenVersion(userId);
    await this.cache.invalidate(userTokenVersionCacheTag(userId), { mode: 'tag' });
  }

  generateAccessToken(userId: string, email: string, role: string, tokenVersion: number): string {
    const payload: JwtPayload = { sub: userId, email, role, tokenVersion };
    return this.jwtStrategyProvider.sign(payload);
  }

  generateRefreshToken(userId: string, tokenVersion: number): string {
    return this.jwtRefreshStrategyProvider.sign({ sub: userId, tokenVersion });
  }
}

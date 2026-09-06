import { Injectable } from '@nestjs/common';
import { JwtStrategyProvider, JwtRefreshStrategyProvider } from '@nathapp/nestjs-auth';
import { AuthException } from '@nathapp/nestjs-common';
import { CacheManager } from '@nathapp/nestjs-cache';
import * as bcrypt from 'bcrypt';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import type { IPrincipal } from './types';
import { UserResponseDto } from './dto/auth-response.dto';
import { PrismaAuthRepository } from './prisma-auth.repository';
import { userTokenVersionCacheTag } from './token-version.cache';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  tokenVersion: number;
}

@Injectable()
export class AuthService {
  constructor(
    private authRepo: PrismaAuthRepository,
    private jwtStrategyProvider: JwtStrategyProvider,
    private jwtRefreshStrategyProvider: JwtRefreshStrategyProvider,
    private cache: CacheManager,
  ) {}

  async register(registerDto: RegisterDto) {
    const { email, password } = registerDto;
    const name = registerDto.name ?? email.split('@')[0];

    const passwordHash = await bcrypt.hash(password, 12);

    // The existence-check + create are serialized inside a single transaction
    // so two concurrent registrations against an empty DB cannot both
    // receive the bootstrap ADMIN role.
    const { user } = await this.authRepo.findAnyUserAndCreate({
      email,
      name,
      passwordHash,
    });

    const accessToken = this.generateAccessToken(user.id, user.email, user.role, user.tokenVersion);
    const refreshToken = this.generateRefreshToken(user.id, user.tokenVersion);

    return {
      accessToken,
      refreshToken,
      user: UserResponseDto.from(user),
    };
  }

  async login(loginDto: LoginDto) {
    const { email, password } = loginDto;

    const user = await this.authRepo.findUserByEmail(email);

    if (!user) {
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

  async validateUser(payload: JwtPayload) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const user = await this.authRepo.findUserById(payload.sub ?? (payload as any).id);

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

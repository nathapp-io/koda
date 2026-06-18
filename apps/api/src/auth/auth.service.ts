import { Injectable } from '@nestjs/common';
import { JwtStrategyProvider, JwtRefreshStrategyProvider } from '@nathapp/nestjs-auth';
import { AuthException } from '@nathapp/nestjs-common';
import * as bcrypt from 'bcrypt';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import type { IPrincipal } from './types';
import { UserResponseDto } from './dto/auth-response.dto';
import { PrismaAuthRepository } from './prisma-auth.repository';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
}

@Injectable()
export class AuthService {
  constructor(
    private authRepo: PrismaAuthRepository,
    private jwtStrategyProvider: JwtStrategyProvider,
    private jwtRefreshStrategyProvider: JwtRefreshStrategyProvider,
  ) {}

  async register(registerDto: RegisterDto) {
    const { email, password } = registerDto;
    const name = registerDto.name ?? email.split('@')[0];

    const passwordHash = await bcrypt.hash(password, 12);

    const anyUser = await this.authRepo.findAnyUser();
    const role = anyUser === null ? 'ADMIN' : undefined;

    const user = await this.authRepo.createUser({
      email,
      name,
      passwordHash,
      ...(role ? { role } : {}),
    });

    const accessToken = this.generateAccessToken(user.id, user.email, user.role);
    const refreshToken = this.generateRefreshToken(user.id);

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

    const accessToken = this.generateAccessToken(user.id, user.email, user.role);
    const refreshToken = this.generateRefreshToken(user.id);

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

    const accessToken = this.generateAccessToken(user.id, user.email, user.role);
    const refreshToken = this.generateRefreshToken(user.id);

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

  generateAccessToken(userId: string, email: string, role: string): string {
    const payload: JwtPayload = { sub: userId, email, role };
    return this.jwtStrategyProvider.sign(payload);
  }

  generateRefreshToken(userId: string): string {
    return this.jwtRefreshStrategyProvider.sign({ sub: userId });
  }
}

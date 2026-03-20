import { Injectable, HttpStatus } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { JwtStrategyProvider, JwtRefreshStrategyProvider } from '@nathapp/nestjs-auth';
import { AppException } from '../common/app-exception';
import * as bcrypt from 'bcrypt';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService<PrismaClient>,
    private jwtStrategyProvider: JwtStrategyProvider,
    private jwtRefreshStrategyProvider: JwtRefreshStrategyProvider,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get db(): PrismaClient { return (this.prisma as any).client ?? (this.prisma as unknown as PrismaClient); }

  async register(registerDto: RegisterDto) {
    const { email, name, password } = registerDto;

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await this.db.user.create({
      data: {
        email,
        name,
        passwordHash,
      },
    });

    const accessToken = this.generateAccessToken(user.id, user.email, user.role);
    const refreshToken = this.generateRefreshToken(user.id);

    return {
      accessToken,
      refreshToken,
      user: this.formatUser(user),
    };
  }

  async login(loginDto: LoginDto) {
    const { email, password } = loginDto;

    const user = await this.db.user.findUnique({
      where: { email },
    });

    if (!user) {
      throw new AppException('auth.invalidCredentials', HttpStatus.UNAUTHORIZED);
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      throw new AppException('auth.invalidCredentials', HttpStatus.UNAUTHORIZED);
    }

    const accessToken = this.generateAccessToken(user.id, user.email, user.role);
    const refreshToken = this.generateRefreshToken(user.id);

    return {
      accessToken,
      refreshToken,
      user: this.formatUser(user),
    };
  }

  async refresh(payload: JwtPayload) {
    const user = await this.db.user.findUnique({
      where: { id: payload.sub },
    });

    if (!user) {
      throw new AppException('errors.unauthorized', HttpStatus.UNAUTHORIZED);
    }

    const accessToken = this.generateAccessToken(user.id, user.email, user.role);
    const refreshToken = this.generateRefreshToken(user.id);

    return {
      accessToken,
      refreshToken,
      user: this.formatUser(user),
    };
  }

  async validateUser(payload: JwtPayload) {
    const user = await this.db.user.findUnique({
      where: { id: payload.sub },
    });

    return user || null;
  }

  generateAccessToken(userId: string, email: string, role: string): string {
    const payload: JwtPayload = { sub: userId, email, role };
    return this.jwtStrategyProvider.sign(payload);
  }

  generateRefreshToken(userId: string): string {
    return this.jwtRefreshStrategyProvider.sign({ sub: userId });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private formatUser(user: any) {
    const { passwordHash: _passwordHash, ...userWithoutPassword } = user;
    return userWithoutPassword;
  }
}

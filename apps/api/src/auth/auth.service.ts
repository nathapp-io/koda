import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { JwtStrategyProvider, JwtRefreshStrategyProvider } from '@nathapp/nestjs-auth';
import { AuthException } from '@nathapp/nestjs-common';
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

  private get db() { return this.prisma.client; }

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
      throw new AuthException();
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      throw new AuthException();
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
      where: { id: payload.sub ?? (payload as any).id },
    });

    if (!user) {
      throw new AuthException();
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
      where: { id: payload.sub ?? (payload as any).id },
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

import { Injectable, Inject, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { AppException } from '../common/app-exception';
import * as bcrypt from 'bcrypt';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
}

// Use require() to avoid static @nestjs/jwt imports while retaining JwtService DI token
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const JwtServiceToken = (require('@nestjs/jwt') as any).JwtService;

interface JwtSigner {
  signAsync(payload: Record<string, unknown>, options?: Record<string, unknown>): Promise<string>;
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService<PrismaClient>,
    @Inject(JwtServiceToken) private jwtService: JwtSigner,
    private configService: ConfigService,
  ) {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get db(): PrismaClient { return (this.prisma as any).client ?? (this.prisma as unknown as PrismaClient); }


  async register(registerDto: RegisterDto) {
    const { email, name, password } = registerDto;

    // Hash password with 12 rounds
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user
    const user = await this.db.user.create({
      data: {
        email,
        name,
        passwordHash,
      },
    });

    // Generate tokens
    const accessToken = await this.generateAccessToken(user.id, user.email, user.role);
    const refreshToken = await this.generateRefreshToken(user.id);

    return {
      accessToken,
      refreshToken,
      user: this.formatUser(user),
    };
  }

  async login(loginDto: LoginDto) {
    const { email, password } = loginDto;

    // Find user by email
    const user = await this.db.user.findUnique({
      where: { email },
    });

    if (!user) {
      throw new AppException('auth.invalidCredentials', HttpStatus.UNAUTHORIZED);
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      throw new AppException('auth.invalidCredentials', HttpStatus.UNAUTHORIZED);
    }

    // Generate tokens
    const accessToken = await this.generateAccessToken(user.id, user.email, user.role);
    const refreshToken = await this.generateRefreshToken(user.id);

    return {
      accessToken,
      refreshToken,
      user: this.formatUser(user),
    };
  }

  async refresh(payload: JwtPayload) {
    // Validate user still exists
    const user = await this.db.user.findUnique({
      where: { id: payload.sub },
    });

    if (!user) {
      throw new AppException('errors.unauthorized', HttpStatus.UNAUTHORIZED);
    }

    // Generate new tokens
    const accessToken = await this.generateAccessToken(user.id, user.email, user.role);
    const refreshToken = await this.generateRefreshToken(user.id);

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

  async generateAccessToken(userId: string, email: string, role: string): Promise<string> {
    const payload: JwtPayload = {
      sub: userId,
      email,
      role,
    };

    const expiresIn = this.configService.get<string>('JWT_EXPIRES_IN') ?? '7d';
    return this.jwtService.signAsync(payload as unknown as Record<string, unknown>, { expiresIn });
  }

  async generateRefreshToken(userId: string): Promise<string> {
    const payload = {
      sub: userId,
    };

    const expiresIn = this.configService.get<string>('JWT_REFRESH_EXPIRES_IN') ?? '30d';
    return this.jwtService.signAsync(payload, {
      expiresIn,
      secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private formatUser(user: any) {
    const { passwordHash: _passwordHash, ...userWithoutPassword } = user;
    return userWithoutPassword;
  }
}

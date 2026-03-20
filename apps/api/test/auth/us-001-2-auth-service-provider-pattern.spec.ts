/**
 * US-001-2: Rewrite AuthService using nathapp auth provider pattern
 *
 * AC1 — AuthService has no import or injection of JwtService from @nestjs/jwt
 * AC2 — Login endpoint returns valid JWT access + refresh tokens
 * AC3 — Register endpoint returns valid JWT access + refresh tokens
 * AC4 — Refresh endpoint returns new valid JWT access token
 * AC5 — @Principal() used in AuthController instead of manual request.user access
 */

import * as fs from 'fs';
import * as path from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtStrategyProvider, JwtRefreshStrategyProvider } from '@nathapp/nestjs-auth';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { AuthService } from '../../src/auth/auth.service';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { AppException } from '../../src/common/app-exception';

const SRC = path.resolve(__dirname, '../../src');

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(SRC, relPath), 'utf-8');
}

// ---------------------------------------------------------------------------
// AC1 — No JwtService from @nestjs/jwt in auth.service.ts
// ---------------------------------------------------------------------------

describe('AC1 — AuthService has no JwtService from @nestjs/jwt', () => {
  let source: string;

  beforeAll(() => {
    source = readSrc('auth/auth.service.ts');
  });

  it('does not import JwtService from @nestjs/jwt', () => {
    expect(source).not.toMatch(
      /import\s*\{[^}]*JwtService[^}]*\}\s*from\s*['"]@nestjs\/jwt['"]/,
    );
  });

  it('does not use require(@nestjs/jwt) to obtain JwtService token', () => {
    expect(source).not.toMatch(/require\s*\(\s*['"]@nestjs\/jwt['"]\s*\)/);
  });

  it('does not inject JwtService or JwtServiceToken in constructor', () => {
    expect(source).not.toMatch(/JwtServiceToken/);
    expect(source).not.toMatch(/@Inject\s*\([^)]*JwtService[^)]*\)/);
  });
});

// ---------------------------------------------------------------------------
// AC2/AC3/AC4 — Token generation via nathapp JwtStrategyProvider
// ---------------------------------------------------------------------------

describe('AuthService — token generation via JwtStrategyProvider (no JwtService)', () => {
  let service: AuthService;

  const mockUser = {
    id: 'user-123',
    email: 'test@example.com',
    name: 'Test User',
    passwordHash: 'hashed-password',
    role: 'MEMBER',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockPrismaService = {
    client: {
      user: {
        create: jest.fn(),
        findUnique: jest.fn(),
      },
    },
  };

  const mockConfigService = {
    get: jest.fn().mockReturnValue('7d'),
  };

  // Mocked JwtStrategyProvider from @nathapp/nestjs-auth (access tokens)
  const mockJwtStrategyProvider = {
    sign: jest.fn().mockReturnValue('mock-access-token'),
  };

  // Mocked JwtRefreshStrategyProvider from @nathapp/nestjs-auth (refresh tokens)
  const mockJwtRefreshStrategyProvider = {
    sign: jest.fn().mockReturnValue('mock-refresh-token'),
  };

  beforeEach(async () => {
    // This TestingModule provides JwtStrategyProvider and JwtRefreshStrategyProvider
    // from @nathapp/nestjs-auth. If AuthService still injects JwtService from @nestjs/jwt,
    // this module will fail to compile (Nest can't resolve dependencies).
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: JwtStrategyProvider, useValue: mockJwtStrategyProvider },
        { provide: JwtRefreshStrategyProvider, useValue: mockJwtRefreshStrategyProvider },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('AC3 — register returns valid JWT access + refresh tokens', () => {
    it('returns accessToken and refreshToken', async () => {
      mockPrismaService.client.user.create.mockResolvedValue(mockUser);

      const result = await service.register({
        email: 'newuser@example.com',
        name: 'New User',
        password: 'password123',
      });

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(result.accessToken).toBeTruthy();
      expect(result.refreshToken).toBeTruthy();
    });

    it('calls JwtStrategyProvider.sign for access token generation', async () => {
      mockPrismaService.client.user.create.mockResolvedValue(mockUser);

      await service.register({
        email: 'newuser@example.com',
        name: 'New User',
        password: 'password123',
      });

      expect(mockJwtStrategyProvider.sign).toHaveBeenCalled();
    });

    it('calls JwtRefreshStrategyProvider.sign for refresh token generation', async () => {
      mockPrismaService.client.user.create.mockResolvedValue(mockUser);

      await service.register({
        email: 'newuser@example.com',
        name: 'New User',
        password: 'password123',
      });

      expect(mockJwtRefreshStrategyProvider.sign).toHaveBeenCalled();
    });

    it('returns distinct access and refresh token values', async () => {
      mockPrismaService.client.user.create.mockResolvedValue(mockUser);

      const result = await service.register({
        email: 'newuser@example.com',
        name: 'New User',
        password: 'password123',
      });

      // Access token and refresh token must not be the same string
      expect(result.accessToken).not.toEqual(result.refreshToken);
    });

    it('does not include passwordHash in returned user', async () => {
      mockPrismaService.client.user.create.mockResolvedValue(mockUser);

      const result = await service.register({
        email: 'newuser@example.com',
        name: 'New User',
        password: 'password123',
      });

      expect(result.user).not.toHaveProperty('passwordHash');
    });
  });

  describe('AC2 — login returns valid JWT access + refresh tokens', () => {
    it('returns accessToken and refreshToken for valid credentials', async () => {
      const password = 'password123';
      const hashedPassword = await bcrypt.hash(password, 12);
      const userWithHash = { ...mockUser, passwordHash: hashedPassword };

      mockPrismaService.client.user.findUnique.mockResolvedValue(userWithHash);

      const result = await service.login({ email: mockUser.email, password });

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(result.accessToken).toBeTruthy();
      expect(result.refreshToken).toBeTruthy();
    });

    it('calls JwtStrategyProvider.sign for access token generation', async () => {
      const password = 'password123';
      const hashedPassword = await bcrypt.hash(password, 12);
      mockPrismaService.client.user.findUnique.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await service.login({ email: mockUser.email, password });

      expect(mockJwtStrategyProvider.sign).toHaveBeenCalled();
    });

    it('calls JwtRefreshStrategyProvider.sign for refresh token generation', async () => {
      const password = 'password123';
      const hashedPassword = await bcrypt.hash(password, 12);
      mockPrismaService.client.user.findUnique.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await service.login({ email: mockUser.email, password });

      expect(mockJwtRefreshStrategyProvider.sign).toHaveBeenCalled();
    });

    it('throws 401 AppException for invalid password', async () => {
      mockPrismaService.client.user.findUnique.mockResolvedValue(mockUser);

      await expect(
        service.login({ email: mockUser.email, password: 'wrongpassword' }),
      ).rejects.toThrow(AppException);
    });

    it('throws 401 AppException for non-existent user', async () => {
      mockPrismaService.client.user.findUnique.mockResolvedValue(null);

      await expect(
        service.login({ email: 'no@example.com', password: 'password123' }),
      ).rejects.toThrow(AppException);
    });
  });

  describe('AC4 — refresh returns new valid JWT access token', () => {
    it('returns a new accessToken', async () => {
      mockPrismaService.client.user.findUnique.mockResolvedValue(mockUser);

      const result = await service.refresh({
        sub: mockUser.id,
        email: mockUser.email,
        role: mockUser.role,
      });

      expect(result).toHaveProperty('accessToken');
      expect(result.accessToken).toBeTruthy();
    });

    it('calls JwtStrategyProvider.sign for the new access token', async () => {
      mockPrismaService.client.user.findUnique.mockResolvedValue(mockUser);

      await service.refresh({
        sub: mockUser.id,
        email: mockUser.email,
        role: mockUser.role,
      });

      expect(mockJwtStrategyProvider.sign).toHaveBeenCalled();
    });

    it('throws 401 AppException when user no longer exists', async () => {
      mockPrismaService.client.user.findUnique.mockResolvedValue(null);

      await expect(
        service.refresh({ sub: 'deleted-user', email: 'x@y.com', role: 'MEMBER' }),
      ).rejects.toThrow(AppException);
    });
  });
});

// ---------------------------------------------------------------------------
// AC5 — @Principal() used in AuthController instead of @CurrentUser()
// ---------------------------------------------------------------------------

describe('AC5 — @Principal() used in AuthController', () => {
  let source: string;

  beforeAll(() => {
    source = readSrc('auth/auth.controller.ts');
  });

  it('imports Principal from @nathapp/nestjs-auth', () => {
    expect(source).toMatch(
      /import\s*\{[^}]*\bPrincipal\b[^}]*\}\s*from\s*['"]@nathapp\/nestjs-auth['"]/,
    );
  });

  it('does not import CurrentUser from local decorator file', () => {
    expect(source).not.toMatch(
      /import\s*\{[^}]*\bCurrentUser\b[^}]*\}\s*from\s*['"]\.\/decorators\/current-user\.decorator['"]/,
    );
  });

  it('uses @Principal() on the refresh endpoint user parameter', () => {
    // @Principal() must appear as a parameter decorator before the user param in refresh
    const refreshMethodRegion = source.match(
      /async\s+refresh\s*\([\s\S]{0,500}?\)/,
    );
    expect(refreshMethodRegion).not.toBeNull();
    expect(refreshMethodRegion?.[0]).toMatch(/@Principal\s*\(\s*\)/);
  });

  it('uses @Principal() on the me endpoint user parameter', () => {
    const meMethodRegion = source.match(/async\s+me\s*\([\s\S]{0,300}?\)/);
    expect(meMethodRegion).not.toBeNull();
    expect(meMethodRegion?.[0]).toMatch(/@Principal\s*\(\s*\)/);
  });

  it('has no @CurrentUser() decorator usage anywhere in the controller', () => {
    expect(source).not.toMatch(/@CurrentUser\s*\(\s*\)/);
  });
});

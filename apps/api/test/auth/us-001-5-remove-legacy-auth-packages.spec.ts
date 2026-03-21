/**
 * US-001-5: Remove legacy auth packages and validate auth test coverage
 *
 * Acceptance Criteria:
 * AC1 — @nestjs/jwt, @nestjs/passport, passport-jwt absent from apps/api/package.json
 * AC2 — No import in apps/api/src references @nestjs/jwt, @nestjs/passport, or passport-jwt
 * AC3 — Auth module test coverage >= 80% (supplemental unit tests for missing branches)
 * AC4 — bun run --cwd apps/api lint exits 0 with 0 warnings
 * AC5 — bun run --cwd apps/api type-check exits 0
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus } from '@nestjs/common';
import { JwtStrategyProvider, JwtRefreshStrategyProvider } from '@nathapp/nestjs-auth';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../../src/auth/auth.service';
import { AuthController } from '../../src/auth/auth.controller';
import { AppException, AuthException, JsonResponse } from '@nathapp/nestjs-common';

const API_ROOT = path.resolve(__dirname, '../..');
const SRC = path.resolve(API_ROOT, 'src');
const PACKAGE_JSON = path.resolve(API_ROOT, 'package.json');

// ---------------------------------------------------------------------------
// AC1 — Legacy packages must not appear in package.json
// ---------------------------------------------------------------------------

describe('AC1 — legacy auth packages absent from package.json', () => {
  let pkg: Record<string, unknown>;

  beforeAll(() => {
    pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf-8'));
  });

  it('@nestjs/jwt is not in dependencies', () => {
    const deps = (pkg.dependencies ?? {}) as Record<string, string>;
    expect(deps).not.toHaveProperty('@nestjs/jwt');
  });

  it('@nestjs/jwt is not in devDependencies', () => {
    const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
    expect(devDeps).not.toHaveProperty('@nestjs/jwt');
  });

  it('@nestjs/passport is not in dependencies', () => {
    const deps = (pkg.dependencies ?? {}) as Record<string, string>;
    expect(deps).not.toHaveProperty('@nestjs/passport');
  });

  it('@nestjs/passport is not in devDependencies', () => {
    const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
    expect(devDeps).not.toHaveProperty('@nestjs/passport');
  });

  it('passport-jwt is not in dependencies', () => {
    const deps = (pkg.dependencies ?? {}) as Record<string, string>;
    expect(deps).not.toHaveProperty('passport-jwt');
  });

  it('passport-jwt is not in devDependencies', () => {
    const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
    expect(devDeps).not.toHaveProperty('passport-jwt');
  });
});

// ---------------------------------------------------------------------------
// AC2 — No import in src/ references the legacy packages
// ---------------------------------------------------------------------------

function getAllTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

describe('AC2 — no src file imports legacy auth packages', () => {
  const legacyPattern = /from\s+['"](@nestjs\/jwt|@nestjs\/passport|passport-jwt)['"]/;

  it('no file in src/ imports @nestjs/jwt', () => {
    const violations: string[] = [];
    for (const file of getAllTsFiles(SRC)) {
      const content = fs.readFileSync(file, 'utf-8');
      if (/@nestjs\/jwt/.test(content)) {
        violations.push(path.relative(SRC, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it('no file in src/ imports @nestjs/passport', () => {
    const violations: string[] = [];
    for (const file of getAllTsFiles(SRC)) {
      const content = fs.readFileSync(file, 'utf-8');
      if (/@nestjs\/passport/.test(content)) {
        violations.push(path.relative(SRC, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it('no file in src/ imports passport-jwt', () => {
    const violations: string[] = [];
    for (const file of getAllTsFiles(SRC)) {
      const content = fs.readFileSync(file, 'utf-8');
      if (/passport-jwt/.test(content)) {
        violations.push(path.relative(SRC, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it('no file in src/ has any import matching legacy package pattern', () => {
    const violations: string[] = [];
    for (const file of getAllTsFiles(SRC)) {
      const content = fs.readFileSync(file, 'utf-8');
      if (legacyPattern.test(content)) {
        violations.push(path.relative(SRC, file));
      }
    }
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC3 — Auth module unit tests: supplemental branch coverage
//
// The existing auth.service.spec.ts and auth.controller.spec.ts cover happy
// paths. The tests below cover uncovered branches to push the auth module
// branch coverage above 80%.
// ---------------------------------------------------------------------------

describe('AC3 — AuthService supplemental branch coverage', () => {
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

  const mockConfigService = { get: jest.fn() };

  const mockJwtStrategyProvider = { sign: jest.fn().mockReturnValue('mock-access-token') };
  const mockJwtRefreshStrategyProvider = { sign: jest.fn().mockReturnValue('mock-refresh-token') };

  let service: AuthService;

  beforeEach(async () => {
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
    jest.clearAllMocks();
    mockJwtStrategyProvider.sign.mockReturnValue('mock-access-token');
    mockJwtRefreshStrategyProvider.sign.mockReturnValue('mock-refresh-token');
  });

  describe('refresh() — user not found branch', () => {
    it('throws AppException with UNAUTHORIZED status when user does not exist', async () => {
      mockPrismaService.client.user.findUnique.mockResolvedValue(null);

      await expect(
        service.refresh({ sub: 'nonexistent-id', email: 'gone@example.com', role: 'MEMBER' }),
      ).rejects.toThrow(AuthException);
    });

    it('throws with 401 status when user not found during refresh', async () => {
      mockPrismaService.client.user.findUnique.mockResolvedValue(null);

      let thrownError: unknown;
      try {
        await service.refresh({ sub: 'ghost-id', email: 'ghost@example.com', role: 'MEMBER' });
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeInstanceOf(AuthException);
      expect((thrownError as AuthException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('queries the database with the payload sub as user id', async () => {
      mockPrismaService.client.user.findUnique.mockResolvedValue(null);
      const payload = { sub: 'specific-user-id', email: 'x@example.com', role: 'MEMBER' };

      await expect(service.refresh(payload)).rejects.toThrow(AuthException);

      expect(mockPrismaService.client.user.findUnique).toHaveBeenCalledWith({
        where: { id: payload.sub },
      });
    });

    it('returns new tokens when user exists during refresh', async () => {
      mockPrismaService.client.user.findUnique.mockResolvedValue(mockUser);

      const result = await service.refresh({
        sub: mockUser.id,
        email: mockUser.email,
        role: mockUser.role,
      });

      expect(result.accessToken).toBe('mock-access-token');
      expect(result.refreshToken).toBe('mock-refresh-token');
      expect(result.user).not.toHaveProperty('passwordHash');
    });
  });

  describe('validateUser() — null return branch', () => {
    it('returns null when user is not found for the given JWT payload', async () => {
      mockPrismaService.client.user.findUnique.mockResolvedValue(null);

      const result = await service.validateUser({
        sub: 'missing-id',
        email: 'missing@example.com',
        role: 'MEMBER',
      });

      expect(result).toBeNull();
    });
  });
});

describe('AC3 — AuthController supplemental branch coverage', () => {
  const mockUser = {
    id: 'user-123',
    email: 'test@example.com',
    name: 'Test User',
    role: 'MEMBER',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockAuthService = {
    register: jest.fn(),
    login: jest.fn(),
    refresh: jest.fn(),
    validateUser: jest.fn(),
    generateAccessToken: jest.fn(),
    generateRefreshToken: jest.fn(),
  };

  let controller: AuthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: mockAuthService }],
    }).compile();

    controller = module.get<AuthController>(AuthController);
    jest.clearAllMocks();
  });

  describe('refresh() — missing or non-Bearer auth header', () => {
    it('throws AppException when Authorization header is absent (undefined)', async () => {
      const user = { sub: mockUser.id, email: mockUser.email, role: mockUser.role };

      await expect(controller.refresh(user, undefined as unknown as string)).rejects.toThrow(
        AppException,
      );
      expect(mockAuthService.refresh).not.toHaveBeenCalled();
    });

    it('throws AppException when Authorization header is an empty string', async () => {
      const user = { sub: mockUser.id, email: mockUser.email, role: mockUser.role };

      await expect(controller.refresh(user, '')).rejects.toThrow(AuthException);
      expect(mockAuthService.refresh).not.toHaveBeenCalled();
    });

    it('throws AppException when Authorization header does not use Bearer scheme', async () => {
      const user = { sub: mockUser.id, email: mockUser.email, role: mockUser.role };

      await expect(controller.refresh(user, 'Basic dXNlcjpwYXNz')).rejects.toThrow(AuthException);
      expect(mockAuthService.refresh).not.toHaveBeenCalled();
    });

    it('throws AppException with UNAUTHORIZED status for non-Bearer header', async () => {
      const user = { sub: mockUser.id, email: mockUser.email, role: mockUser.role };

      let thrown: unknown;
      try {
        await controller.refresh(user, 'Token xyz');
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(AuthException);
      expect((thrown as AuthException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    });
  });

  describe('me() — validateUser returns null', () => {
    it('throws AppException when validateUser returns null', async () => {
      const user = { sub: mockUser.id, email: mockUser.email, role: mockUser.role };
      mockAuthService.validateUser.mockResolvedValue(null);

      await expect(controller.me(user)).rejects.toThrow(AuthException);
    });

    it('throws with UNAUTHORIZED status when user not found by validateUser', async () => {
      const user = { sub: mockUser.id, email: mockUser.email, role: mockUser.role };
      mockAuthService.validateUser.mockResolvedValue(null);

      let thrown: unknown;
      try {
        await controller.me(user);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(AuthException);
      expect((thrown as AuthException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('does not call any response builder when validateUser returns null', async () => {
      const user = { sub: mockUser.id, email: mockUser.email, role: mockUser.role };
      mockAuthService.validateUser.mockResolvedValue(null);

      let result: JsonResponse<unknown> | undefined;
      try {
        result = await controller.me(user);
      } catch {
        // expected
      }

      expect(result).toBeUndefined();
    });

    it('returns wrapped user data when validateUser succeeds', async () => {
      const user = { sub: mockUser.id, email: mockUser.email, role: mockUser.role };
      mockAuthService.validateUser.mockResolvedValue(mockUser);

      const result = await controller.me(user);

      expect(result).toBeInstanceOf(JsonResponse);
    });
  });
});

// ---------------------------------------------------------------------------
// AC4 — Lint must exit 0 with 0 warnings
// ---------------------------------------------------------------------------

describe('AC4 — lint exits 0 with zero warnings', () => {
  it('bun run lint succeeds', () => {
    const result = spawnSync('bun', ['run', 'lint'], {
      cwd: API_ROOT,
      encoding: 'utf-8',
    });

    if (result.status !== 0) {
      console.error('lint stdout:\n', result.stdout);
      console.error('lint stderr:\n', result.stderr);
    }

    expect(result.status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC5 — TypeScript type-check must exit 0
// ---------------------------------------------------------------------------

describe('AC5 — type-check exits 0', () => {
  it('bun run type-check succeeds with no errors', () => {
    const result = spawnSync('bun', ['run', 'type-check'], {
      cwd: API_ROOT,
      encoding: 'utf-8',
    });

    if (result.status !== 0) {
      console.error('type-check stdout:\n', result.stdout);
      console.error('type-check stderr:\n', result.stderr);
    }

    expect(result.status).toBe(0);
  });
});

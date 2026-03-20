/**
 * US-001-1: Install @nathapp/nestjs-auth and wire AuthModule.forRootAsync
 *
 * Acceptance Criteria:
 * AC1 — @nathapp/nestjs-auth present in apps/api/package.json
 * AC2 — auth.module.ts uses AuthModule.forRootAsync with JWT config
 * AC3 — No JwtModule import from @nestjs/jwt in auth.module.ts
 * AC4 — AppModule has no APP_GUARD provider
 * AC5 — useAppGlobalGuards() called in main.ts
 * AC6 — @Public() applied to login, register, and refresh endpoints
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../../src');

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(SRC, relPath), 'utf-8');
}

function readPkg(): Record<string, unknown> {
  const pkgPath = path.resolve(__dirname, '../../package.json');
  return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// AC1 — @nathapp/nestjs-auth in package.json
// ---------------------------------------------------------------------------

describe('AC1 — @nathapp/nestjs-auth in package.json', () => {
  it('lists @nathapp/nestjs-auth as a dependency', () => {
    const pkg = readPkg();
    const deps = (pkg['dependencies'] ?? {}) as Record<string, string>;
    expect(Object.keys(deps)).toContain('@nathapp/nestjs-auth');
  });
});

// ---------------------------------------------------------------------------
// AC2 — auth.module.ts uses AuthModule.forRootAsync
// ---------------------------------------------------------------------------

describe('AC2 — auth.module.ts uses AuthModule.forRootAsync', () => {
  let source: string;

  beforeAll(() => {
    source = readSrc('auth/auth.module.ts');
  });

  it('imports AuthModule from @nathapp/nestjs-auth', () => {
    expect(source).toMatch(/from\s+['"]@nathapp\/nestjs-auth['"]/);
  });

  it('calls AuthModule.forRootAsync', () => {
    expect(source).toMatch(/AuthModule\.forRootAsync\s*\(/);
  });

  it('passes JWT secret from ConfigService', () => {
    // After US-005 typed config refactor, check for typed config access
    expect(source).toMatch(/jwtSecret|JWT_SECRET/);
  });

  it('passes JWT expires-in from ConfigService', () => {
    // After US-005 typed config refactor, check for typed config access
    expect(source).toMatch(/jwtExpiresIn|JWT_EXPIRES_IN/);
  });
});

// ---------------------------------------------------------------------------
// AC3 — No JwtModule from @nestjs/jwt in auth.module.ts
// ---------------------------------------------------------------------------

describe('AC3 — auth.module.ts has no JwtModule from @nestjs/jwt', () => {
  let source: string;

  beforeAll(() => {
    source = readSrc('auth/auth.module.ts');
  });

  it('does not import JwtModule from @nestjs/jwt', () => {
    // Must not have a direct import of JwtModule from @nestjs/jwt
    expect(source).not.toMatch(/import\s*\{[^}]*JwtModule[^}]*\}\s*from\s*['"]@nestjs\/jwt['"]/);
  });

  it('does not use JwtModule.registerAsync', () => {
    expect(source).not.toMatch(/JwtModule\.registerAsync\s*\(/);
  });

  it('does not register JwtModule in the imports array', () => {
    // Any reference to JwtModule (as a registration call) should be absent
    expect(source).not.toMatch(/JwtModule\s*\./);
  });
});

// ---------------------------------------------------------------------------
// AC4 — AppModule has no APP_GUARD provider
// ---------------------------------------------------------------------------

describe('AC4 — AppModule has no APP_GUARD provider', () => {
  let source: string;

  beforeAll(() => {
    source = readSrc('app.module.ts');
  });

  it('does not import APP_GUARD from @nestjs/core', () => {
    expect(source).not.toMatch(/APP_GUARD/);
  });

  it('does not register CombinedAuthGuard via APP_GUARD token', () => {
    expect(source).not.toMatch(/provide\s*:\s*APP_GUARD/);
  });
});

// ---------------------------------------------------------------------------
// AC5 — useAppGlobalGuards() called in main.ts
// ---------------------------------------------------------------------------

describe('AC5 — main.ts calls useAppGlobalGuards()', () => {
  let source: string;

  beforeAll(() => {
    source = readSrc('main.ts');
  });

  it('calls useAppGlobalGuards()', () => {
    expect(source).toMatch(/\.useAppGlobalGuards\s*\(\s*\)/);
  });
});

// ---------------------------------------------------------------------------
// AC6 — @Public() from @nathapp/nestjs-auth on login, register, and refresh
// ---------------------------------------------------------------------------

describe('AC6 — @Public() applied to login, register, and refresh in auth.controller.ts', () => {
  let source: string;

  beforeAll(() => {
    source = readSrc('auth/auth.controller.ts');
  });

  it('imports Public from @nathapp/nestjs-auth', () => {
    expect(source).toMatch(/import\s*\{[^}]*\bPublic\b[^}]*\}\s*from\s*['"]@nathapp\/nestjs-auth['"]/);
  });

  it('applies @Public() to the register endpoint', () => {
    // @Public() decorator must appear in close proximity to the register method
    const registerBlock = source.match(
      /@Public\(\)[\s\S]{0,200}async\s+register\s*\(/,
    );
    expect(registerBlock).not.toBeNull();
  });

  it('applies @Public() to the login endpoint', () => {
    const loginBlock = source.match(
      /@Public\(\)[\s\S]{0,200}async\s+login\s*\(/,
    );
    expect(loginBlock).not.toBeNull();
  });

  it('applies @Public() to the refresh endpoint', () => {
    const refreshBlock = source.match(
      /@Public\(\)[\s\S]{0,200}async\s+refresh\s*\(/,
    );
    expect(refreshBlock).not.toBeNull();
  });

  it('does not import IsPublic from a local decorator file for public routes', () => {
    // After the refactor, the local IsPublic decorator should be replaced
    // by Public from @nathapp/nestjs-auth in the controller
    expect(source).not.toMatch(
      /import\s*\{[^}]*\bIsPublic\b[^}]*\}\s*from\s*['"]\.\/decorators\/is-public\.decorator['"]/,
    );
  });
});

/**
 * Acceptance tests for refactor-standard
 * Static code analysis — no running server required.
 * Runtime ACs (AC-3, AC-4, AC-5, AC-7, AC-10, AC-15, AC-22, AC-28, AC-31, AC-38) are covered by the Jest test suite.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const root = join(__dirname, '..', '..', '..', '..'); // repo root
const apiSrc = join(root, 'apps/api/src');

function srcFiles(pattern = '**/*.ts', excludeTests = true): string[] {
  const files = execSync(`find ${apiSrc} -name "*.ts"`, { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  return excludeTests
    ? files.filter(f => !f.includes('.spec.ts') && !f.includes('.test.ts'))
    : files;
}

function readFile(p: string): string {
  try { return readFileSync(p, 'utf8'); } catch { return ''; }
}

function grepSrc(pattern: RegExp, excludeTests = true): string[] {
  return srcFiles('**/*.ts', excludeTests).filter(f => pattern.test(readFile(f)));
}

function apiPkg() {
  return JSON.parse(readFileSync(join(root, 'apps/api/package.json'), 'utf8'));
}

function rootPkg() {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
}

function allDeps(pkg: any) {
  return { ...pkg.dependencies, ...pkg.devDependencies };
}

const appModule = readFile(join(apiSrc, 'app.module.ts'));
const mainTs = readFile(join(apiSrc, 'main.ts'));

describe('refactor-standard - Acceptance Tests', () => {

  // ── Auth migration ──────────────────────────────────────────────────────────

  test('AC-1: No @nestjs/jwt or @nestjs/passport imports in apps/api/src (prod files)', () => {
    const bad = grepSrc(/from\s+['"]@nestjs\/jwt['"]|from\s+['"]@nestjs\/passport['"]/);
    expect(bad).toHaveLength(0);
  });

  test('AC-2: AuthModule uses @nathapp/nestjs-auth AuthModule.forRootAsync', () => {
    const auth = readFile(join(apiSrc, 'auth/auth.module.ts'));
    expect(auth).toMatch(/@nathapp\/nestjs-auth/);
    expect(auth).toMatch(/AuthModule\.forRootAsync/);
  });

  test('AC-6: AppModule has no APP_GUARD provider', () => {
    expect(appModule).not.toMatch(/APP_GUARD/);
  });

  test('AC-8: @nestjs/jwt, @nestjs/passport, passport-jwt removed from package.json', () => {
    const deps = allDeps(apiPkg());
    expect(deps['@nestjs/jwt']).toBeUndefined();
    expect(deps['@nestjs/passport']).toBeUndefined();
    expect(deps['passport-jwt']).toBeUndefined();
  });

  test('AC-9: Custom guard/strategy files deleted', () => {
    const deleted = ['jwt-auth.guard.ts', 'api-key-auth.guard.ts', 'combined-auth.guard.ts', 'jwt.strategy.ts'];
    for (const f of deleted) {
      const found = execSync(`find ${apiSrc} -name "${f}"`, { encoding: 'utf8' }).trim();
      expect(found).toBe('');
    }
  });

  // ── i18n ────────────────────────────────────────────────────────────────────

  test('AC-11: I18nCoreModule registered in AppModule', () => {
    expect(appModule).toMatch(/I18nCoreModule/);
  });

  test('AC-12: apps/api/src/i18n/en/common.json has required keys', () => {
    const raw = readFileSync(join(apiSrc, 'i18n/en/common.json'), 'utf8');
    const flat = (function flatten(obj: any, prefix = ''): Record<string, string> {
      return Object.entries(obj).reduce((acc, [k, v]) => {
        const key = prefix ? `${prefix}.${k}` : k;
        return typeof v === 'object' ? { ...acc, ...flatten(v, key) } : { ...acc, [key]: v };
      }, {} as Record<string, string>);
    })(JSON.parse(raw));
    const required = [
      'validation.required', 'validation.isEmail', 'validation.minLength',
      'validation.maxLength', 'errors.notFound', 'errors.forbidden', 'errors.unauthorized',
    ];
    for (const k of required) {
      expect(flat[k]).toBeDefined();
    }
  });

  test('AC-13: All 6 locale namespaces exist in both en/ and zh/', () => {
    const namespaces = ['common', 'auth', 'tickets', 'projects', 'agents', 'comments'];
    const locales = ['en', 'zh'];
    for (const ns of namespaces) {
      for (const loc of locales) {
        expect(existsSync(join(apiSrc, `i18n/${loc}/${ns}.json`))).toBe(true);
      }
    }
  });

  test('AC-14: DTO validation decorators carry i18n message keys (no hardcoded English strings)', () => {
    const dtoFiles = execSync(`find ${apiSrc} -name "*.dto.ts"`, { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    for (const f of dtoFiles) {
      const c = readFile(f);
      // Should not have hardcoded English messages like { message: 'Name is required' }
      expect(c).not.toMatch(/@IsNotEmpty\(\s*\{\s*message\s*:\s*['"][A-Z][a-z]/);
      expect(c).not.toMatch(/@IsEmail\(\s*\{\s*\},\s*\{\s*message\s*:\s*['"][A-Z][a-z]/);
    }
  });

  test('AC-16: No hardcoded English strings in DTO validation decorators', () => {
    const dtoFiles = execSync(`find ${apiSrc} -name "*.dto.ts"`, { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    for (const f of dtoFiles) {
      const c = readFile(f);
      expect(c).not.toMatch(/message\s*:\s*['"][A-Z][a-z].*['"]\s*\}/);
    }
  });

  // ── Logging ─────────────────────────────────────────────────────────────────

  test('AC-17: @nathapp/nestjs-logging in apps/api/package.json', () => {
    expect(allDeps(apiPkg())['@nathapp/nestjs-logging']).toBeDefined();
  });

  test('AC-18: LoggingModule registered in AppModule', () => {
    expect(appModule).toMatch(/LoggingModule/);
  });

  test('AC-19: app.useLogger called in main.ts', () => {
    expect(mainTs).toMatch(/useLogger/);
  });

  test('AC-20: No "import { Logger } from @nestjs/common" in prod source', () => {
    const bad = grepSrc(/import\s*\{[^}]*\bLogger\b[^}]*\}\s*from\s*['"]@nestjs\/common['"]/);
    expect(bad).toHaveLength(0);
  });

  test('AC-21: No console.log/error/warn in prod source (excluding test files)', () => {
    const bad = grepSrc(/console\.(log|error|warn)\(/, true);
    expect(bad).toHaveLength(0);
  });

  // ── Response standardization ─────────────────────────────────────────────────

  test('AC-23: All controllers use JsonResponse', () => {
    const ctrlFiles = execSync(`find ${apiSrc} -name "*.controller.ts"`, { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    const bad = ctrlFiles.filter(f => {
      const c = readFile(f);
      return c.includes('@Controller') && !c.includes('JsonResponse');
    });
    expect(bad.map(f => f.split('/').pop())).toHaveLength(0);
  });

  test('AC-24: No raw HTTP exceptions thrown in prod source', () => {
    const bad = grepSrc(/throw new (NotFoundException|ForbiddenException|UnauthorizedException|BadRequestException|ConflictException)\(/);
    expect(bad).toHaveLength(0);
  });

  test('AC-25: AppException calls use i18n keys (not hardcoded messages)', () => {
    const bad = grepSrc(/new AppException\(['"][A-Z][a-z]/);
    expect(bad).toHaveLength(0);
  });

  // ── Config ───────────────────────────────────────────────────────────────────

  test('AC-29: app.config.ts, auth.config.ts, database.config.ts use registerAs', () => {
    for (const cfg of ['app.config.ts', 'auth.config.ts', 'database.config.ts']) {
      const c = readFile(join(apiSrc, `config/${cfg}`));
      expect(c).toMatch(/registerAs/);
    }
  });

  test('AC-30: ConfigModule.forRoot in AppModule has validate function', () => {
    expect(appModule).toMatch(/ConfigModule/);
    expect(appModule).toMatch(/validate/);
  });

  test('AC-32: No raw configService.get("STRING") calls in prod source', () => {
    const bad = grepSrc(/configService\.get\(['"][A-Z_]+['"]\)/);
    expect(bad).toHaveLength(0);
  });

  test('AC-33: apps/api/.env.example exists', () => {
    expect(existsSync(join(root, 'apps/api/.env.example'))).toBe(true);
  });

  // ── Throttle ─────────────────────────────────────────────────────────────────

  test('AC-35: @nathapp/nestjs-throttler in apps/api/package.json', () => {
    expect(allDeps(apiPkg())['@nathapp/nestjs-throttler']).toBeDefined();
  });

  test('AC-36: ThrottlerModule registered in AppModule', () => {
    expect(appModule).toMatch(/ThrottlerModule/);
  });

  test('AC-37: AuthController has throttle decorators on login/register', () => {
    const ctrl = readFile(join(apiSrc, 'auth/auth.controller.ts'));
    expect(ctrl).toMatch(/@Throttle|ThrottleDecorator|throttle/i);
  });

  // ── Prisma ────────────────────────────────────────────────────────────────────

  test('AC-40: No custom PrismaService reimplementation (uses @nathapp/nestjs-prisma)', () => {
    const bad = grepSrc(/class PrismaService/).filter(f => {
      const c = readFile(f);
      return !c.includes('@nathapp/nestjs-prisma');
    });
    expect(bad).toHaveLength(0);
  });

  test('AC-42: apps/api/src/prisma/ directory deleted', () => {
    expect(existsSync(join(apiSrc, 'prisma'))).toBe(false);
  });

  test('AC-43: PrismaModule registered globally in AppModule (feature modules need not re-import)', () => {
    expect(appModule).toMatch(/PrismaModule/);
    expect(appModule).toMatch(/isGlobal\s*:\s*true/);
  });

  // ── AppModule shape ───────────────────────────────────────────────────────────

  test('AC-45: AppModule imports contain all required modules', () => {
    const required = ['ConfigModule', 'LoggingModule', 'I18nCoreModule', 'ThrottlerModule', 'PrismaModule', 'AuthModule'];
    for (const m of required) {
      expect(appModule).toMatch(new RegExp(m));
    }
  });

  test('AC-46: AppModule has no APP_GUARD provider (duplicate check)', () => {
    expect(appModule).not.toMatch(/APP_GUARD/);
  });

  // ── Final quality gate ────────────────────────────────────────────────────────

  test('AC-50: api:export-spec script exists in root package.json', () => {
    expect(rootPkg().scripts?.['api:export-spec']).toBeDefined();
  });
});

/**
 * US-005: Add validated typed config with registerAs and Joi schema
 *
 * Acceptance Criteria:
 * AC1 — app.config.ts, auth.config.ts, and database.config.ts all use registerAs
 * AC2 — ConfigModule.forRoot in AppModule has a validate function using Joi
 * AC3 — App throws a descriptive error on startup when JWT_SECRET or DATABASE_URL is missing
 * AC4 — No configService.get('RAW_STRING') calls remain in auth.module.ts
 * AC5 — apps/api/.env.example is up to date with all required vars
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../../src');
const API_ROOT = path.resolve(__dirname, '../..');

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(SRC, relPath), 'utf-8');
}

function srcExists(relPath: string): boolean {
  return fs.existsSync(path.join(SRC, relPath));
}

function readPkg(): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(API_ROOT, 'package.json'), 'utf-8'),
  ) as Record<string, unknown>;
}

function readEnvExample(): string {
  // .env.example lives in the monorepo root (one level up from apps/api)
  const candidates = [
    path.join(API_ROOT, '.env.example'),
    path.join(API_ROOT, '../../.env.example'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, 'utf-8');
    }
  }
  throw new Error('.env.example not found in expected locations');
}

// ---------------------------------------------------------------------------
// AC1 — config files exist and use registerAs
// ---------------------------------------------------------------------------

describe('AC1 — app.config.ts uses registerAs', () => {
  it('file src/config/app.config.ts exists', () => {
    expect(srcExists('config/app.config.ts')).toBe(true);
  });

  it('imports registerAs from @nestjs/config', () => {
    const source = readSrc('config/app.config.ts');
    expect(source).toMatch(/registerAs/);
    expect(source).toMatch(/from\s+['"]@nestjs\/config['"]/);
  });

  it('exports the app config namespace with registerAs', () => {
    const source = readSrc('config/app.config.ts');
    expect(source).toMatch(/registerAs\s*\(\s*['"]app['"]/);
  });

  it('exposes PORT', () => {
    const source = readSrc('config/app.config.ts');
    expect(source).toMatch(/PORT/);
  });

  it('exposes NODE_ENV', () => {
    const source = readSrc('config/app.config.ts');
    expect(source).toMatch(/NODE_ENV/);
  });

  it('exposes GLOBAL_PREFIX or globalPrefix', () => {
    const source = readSrc('config/app.config.ts');
    expect(source).toMatch(/GLOBAL_PREFIX|globalPrefix/);
  });
});

describe('AC1 — auth.config.ts uses registerAs', () => {
  it('file src/config/auth.config.ts exists', () => {
    expect(srcExists('config/auth.config.ts')).toBe(true);
  });

  it('imports registerAs from @nestjs/config', () => {
    const source = readSrc('config/auth.config.ts');
    expect(source).toMatch(/registerAs/);
    expect(source).toMatch(/from\s+['"]@nestjs\/config['"]/);
  });

  it('exports the auth config namespace with registerAs', () => {
    const source = readSrc('config/auth.config.ts');
    expect(source).toMatch(/registerAs\s*\(\s*['"]auth['"]/);
  });

  it('exposes JWT_SECRET', () => {
    const source = readSrc('config/auth.config.ts');
    expect(source).toMatch(/JWT_SECRET/);
  });

  it('exposes JWT_EXPIRES_IN', () => {
    const source = readSrc('config/auth.config.ts');
    expect(source).toMatch(/JWT_EXPIRES_IN/);
  });

  it('exposes JWT_REFRESH_SECRET', () => {
    const source = readSrc('config/auth.config.ts');
    expect(source).toMatch(/JWT_REFRESH_SECRET/);
  });

  it('exposes JWT_REFRESH_EXPIRES_IN', () => {
    const source = readSrc('config/auth.config.ts');
    expect(source).toMatch(/JWT_REFRESH_EXPIRES_IN/);
  });
});

describe('AC1 — database.config.ts uses registerAs', () => {
  it('file src/config/database.config.ts exists', () => {
    expect(srcExists('config/database.config.ts')).toBe(true);
  });

  it('imports registerAs from @nestjs/config', () => {
    const source = readSrc('config/database.config.ts');
    expect(source).toMatch(/registerAs/);
    expect(source).toMatch(/from\s+['"]@nestjs\/config['"]/);
  });

  it('exports the database config namespace with registerAs', () => {
    const source = readSrc('config/database.config.ts');
    expect(source).toMatch(/registerAs\s*\(\s*['"]database['"]/);
  });

  it('exposes DATABASE_URL', () => {
    const source = readSrc('config/database.config.ts');
    expect(source).toMatch(/DATABASE_URL/);
  });

  it('exposes DATABASE_PROVIDER', () => {
    const source = readSrc('config/database.config.ts');
    expect(source).toMatch(/DATABASE_PROVIDER/);
  });
});

// ---------------------------------------------------------------------------
// AC2 — ConfigModule.forRoot in AppModule has a validate function using Joi
// ---------------------------------------------------------------------------

describe('AC2 — joi is installed and AppModule uses validate', () => {
  it('joi is listed in package.json dependencies', () => {
    const pkg = readPkg();
    const deps = (pkg['dependencies'] ?? {}) as Record<string, string>;
    expect(Object.keys(deps)).toContain('joi');
  });

  it('app.module.ts imports the validate function or Joi schema', () => {
    const source = readSrc('app.module.ts');
    // Either imports validate from config/env.validation or imports Joi directly
    expect(source).toMatch(/validate|joi|Joi/i);
  });

  it('ConfigModule.forRoot passes a validate option', () => {
    const source = readSrc('app.module.ts');
    expect(source).toMatch(/validate\s*:/);
  });

  it('src/config/env.validation.ts exists', () => {
    expect(srcExists('config/env.validation.ts')).toBe(true);
  });

  it('env.validation.ts imports Joi', () => {
    const source = readSrc('config/env.validation.ts');
    expect(source).toMatch(/joi|Joi/i);
    expect(source).toMatch(/from\s+['"]joi['"]/);
  });

  it('env.validation.ts exports a validate function', () => {
    const source = readSrc('config/env.validation.ts');
    expect(source).toMatch(/export\s+(function|const)\s+validate/);
  });
});

// ---------------------------------------------------------------------------
// AC3 — validate() throws on missing JWT_SECRET or DATABASE_URL
// ---------------------------------------------------------------------------

describe('AC3 — validate() throws descriptive errors for missing required vars', () => {
  // Dynamic import so this test can fail when the stub has no real logic
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const getValidate = (): ((config: Record<string, unknown>) => Record<string, unknown>) => {
    const validationPath = path.join(SRC, 'config/env.validation');
    // Clear require cache to get a fresh import
    delete require.cache[require.resolve(validationPath)];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(validationPath) as { validate: (c: Record<string, unknown>) => Record<string, unknown> };
    return mod.validate;
  };

  const VALID_ENV: Record<string, unknown> = {
    DATABASE_PROVIDER: 'sqlite',
    DATABASE_URL: 'file:./koda.db',
    JWT_SECRET: 'super-secret-jwt',
    JWT_EXPIRES_IN: '7d',
    JWT_REFRESH_SECRET: 'super-secret-refresh',
    JWT_REFRESH_EXPIRES_IN: '30d',
    API_KEY_SECRET: 'super-secret-api-key',
    API_PORT: 3100,
    NODE_ENV: 'test',
    GLOBAL_PREFIX: 'api',
  };

  it('throws when JWT_SECRET is missing', () => {
    const validate = getValidate();
    const env = { ...VALID_ENV };
    delete env['JWT_SECRET'];
    expect(() => validate(env)).toThrow();
  });

  it('throws when DATABASE_URL is missing', () => {
    const validate = getValidate();
    const env = { ...VALID_ENV };
    delete env['DATABASE_URL'];
    expect(() => validate(env)).toThrow();
  });

  it('throws when JWT_REFRESH_SECRET is missing', () => {
    const validate = getValidate();
    const env = { ...VALID_ENV };
    delete env['JWT_REFRESH_SECRET'];
    expect(() => validate(env)).toThrow();
  });

  it('throws when API_KEY_SECRET is missing', () => {
    const validate = getValidate();
    const env = { ...VALID_ENV };
    delete env['API_KEY_SECRET'];
    expect(() => validate(env)).toThrow();
  });

  it('returns the validated config when all required vars are present', () => {
    const validate = getValidate();
    expect(() => validate({ ...VALID_ENV })).not.toThrow();
  });

  it('returns an object with PORT defaulting to a number when API_PORT is absent', () => {
    const validate = getValidate();
    const env = { ...VALID_ENV };
    delete env['API_PORT'];
    const result = validate(env);
    expect(typeof result['API_PORT']).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// AC4 — No raw configService.get('STRING') calls remain in auth.module.ts
// ---------------------------------------------------------------------------

describe('AC4 — auth.module.ts uses typed config, not raw string keys', () => {
  let source: string;

  beforeAll(() => {
    source = readSrc('auth/auth.module.ts');
  });

  it('does not call config.get with raw JWT_SECRET string', () => {
    expect(source).not.toMatch(/config\.get\s*\(\s*['"]JWT_SECRET['"]/);
  });

  it('does not call config.get with raw JWT_REFRESH_SECRET string', () => {
    expect(source).not.toMatch(/config\.get\s*\(\s*['"]JWT_REFRESH_SECRET['"]/);
  });

  it('does not call config.get with raw JWT_EXPIRES_IN string', () => {
    expect(source).not.toMatch(/config\.get\s*\(\s*['"]JWT_EXPIRES_IN['"]/);
  });

  it('does not call config.get with raw JWT_REFRESH_EXPIRES_IN string', () => {
    expect(source).not.toMatch(/config\.get\s*\(\s*['"]JWT_REFRESH_EXPIRES_IN['"]/);
  });

  it('injects typed auth config via ConfigService.get("auth") or uses auth config factory', () => {
    // After the refactor, auth.module.ts must reference typed config access
    // e.g. config.get('auth') or inject authConfig using @InjectConfig('auth')
    const usesTypedConfig =
      /config\.get\s*\(\s*['"]auth['"]/.test(source) ||
      /authConfig/.test(source) ||
      /auth\.config/.test(source) ||
      /InjectConfig/.test(source);
    expect(usesTypedConfig).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC5 — .env.example contains all required variables
// ---------------------------------------------------------------------------

describe('AC5 — .env.example is complete with all required vars', () => {
  let envExample: string;

  beforeAll(() => {
    envExample = readEnvExample();
  });

  it('contains DATABASE_URL', () => {
    expect(envExample).toMatch(/DATABASE_URL/);
  });

  it('contains DATABASE_PROVIDER', () => {
    expect(envExample).toMatch(/DATABASE_PROVIDER/);
  });

  it('contains JWT_SECRET', () => {
    expect(envExample).toMatch(/JWT_SECRET/);
  });

  it('contains JWT_EXPIRES_IN', () => {
    expect(envExample).toMatch(/JWT_EXPIRES_IN/);
  });

  it('contains JWT_REFRESH_SECRET', () => {
    expect(envExample).toMatch(/JWT_REFRESH_SECRET/);
  });

  it('contains JWT_REFRESH_EXPIRES_IN', () => {
    expect(envExample).toMatch(/JWT_REFRESH_EXPIRES_IN/);
  });

  it('contains API_KEY_SECRET', () => {
    expect(envExample).toMatch(/API_KEY_SECRET/);
  });

  it('contains API_PORT', () => {
    expect(envExample).toMatch(/API_PORT/);
  });

  it('contains NODE_ENV', () => {
    expect(envExample).toMatch(/NODE_ENV/);
  });
});

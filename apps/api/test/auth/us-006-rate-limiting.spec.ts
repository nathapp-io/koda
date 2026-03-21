/**
 * US-006: Add rate limiting on auth endpoints via @nathapp/nestjs-throttler
 *
 * Acceptance Criteria:
 * AC1 — @nathapp/nestjs-throttler present in apps/api/package.json
 * AC2 — ThrottlerModule.forRootAsync(...) registered in AppModule
 * AC3 — AuthController has @Throttle({ default: { limit: 10, ttl: 60000 } }) applied
 * AC4 — 11th request within a minute returns 429 Too Many Requests
 * AC5 — DefaultThrottlerGuard (proxy-aware) is used, not ThrottlerGuard
 */

import * as fs from 'fs';
import * as path from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus } from '@nestjs/common';
import supertest from 'supertest';
import { AppModule } from '../../src/app.module';

const SRC = path.resolve(__dirname, '../../src');
const PKG_PATH = path.resolve(__dirname, '../../package.json');

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(SRC, relPath), 'utf-8');
}

function readPkg(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(PKG_PATH, 'utf-8')) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// AC1 — @nathapp/nestjs-throttler in package.json
// ---------------------------------------------------------------------------

describe('AC1 — @nathapp/nestjs-throttler in package.json', () => {
  it('lists @nathapp/nestjs-throttler as a dependency', () => {
    const pkg = readPkg();
    const deps = (pkg['dependencies'] ?? {}) as Record<string, string>;
    expect(Object.keys(deps)).toContain('@nathapp/nestjs-throttler');
  });
});

// ---------------------------------------------------------------------------
// AC2 — ThrottlerModule.forRootAsync registered in app.module.ts
// ---------------------------------------------------------------------------

describe('AC2 — ThrottlerModule.forRootAsync registered in AppModule', () => {
  let source: string;

  beforeAll(() => {
    source = readSrc('app.module.ts');
  });

  it('imports ThrottlerModule from @nathapp/nestjs-throttler', () => {
    expect(source).toMatch(/from\s+['"]@nathapp\/nestjs-throttler['"]/);
  });

  it('calls ThrottlerModule.forRootAsync', () => {
    expect(source).toMatch(/ThrottlerModule\.forRootAsync\s*\(/);
  });
});

// ---------------------------------------------------------------------------
// AC3 — AuthController has @Throttle decorator applied
// ---------------------------------------------------------------------------

describe('AC3 — AuthController is throttled at 10 requests per minute', () => {
  let source: string;

  beforeAll(() => {
    source = readSrc('auth/auth.controller.ts');
  });

  it('imports Throttle from @nathapp/nestjs-throttler', () => {
    expect(source).toMatch(/import\s*\{[^}]*\bThrottle\b[^}]*\}\s*from\s*['"]@nathapp\/nestjs-throttler['"]/);
  });

  it('applies @Throttle decorator to the AuthController class', () => {
    // @Throttle(...) must appear before the @Controller('auth') class declaration
    expect(source).toMatch(/@Throttle\s*\(/);
  });

  it('sets limit to 10', () => {
    expect(source).toMatch(/limit\s*:\s*10/);
  });

  it('sets ttl to 60000 (1 minute)', () => {
    expect(source).toMatch(/ttl\s*:\s*60000/);
  });
});

// ---------------------------------------------------------------------------
// AC5 — DefaultThrottlerGuard is used (proxy-aware, required for Fastify)
// ---------------------------------------------------------------------------

describe('AC5 — DefaultThrottlerGuard used in AppModule (proxy-aware)', () => {
  let source: string;

  beforeAll(() => {
    source = readSrc('app.module.ts');
  });

  it('imports DefaultThrottlerGuard from @nathapp/nestjs-throttler', () => {
    expect(source).toMatch(/DefaultThrottlerGuard/);
  });

  it('does not use the bare ThrottlerGuard (which is not proxy-aware)', () => {
    // ThrottlerGuard from @nestjs/throttler must not be used directly
    expect(source).not.toMatch(/from\s+['"]@nestjs\/throttler['"]/);
  });
});

// ---------------------------------------------------------------------------
// AC4 — Integration: 11th request within a minute returns 429
// ---------------------------------------------------------------------------

describe('AC4 — 11th login request within a minute returns 429', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 429 on the 11th POST /api/auth/login within the throttle window', async () => {
    const loginPayload = { email: 'throttle-test@example.com', password: 'wrong-password' };

    // Send 10 requests — all should be processed (may succeed or fail with 401/400,
    // but NOT 429)
    for (let i = 0; i < 10; i++) {
      const res = await supertest(app.getHttpServer())
        .post('/api/auth/login')
        .send(loginPayload);
      expect(res.status).not.toBe(HttpStatus.TOO_MANY_REQUESTS);
    }

    // The 11th request must be rate-limited
    const eleventh = await supertest(app.getHttpServer())
      .post('/api/auth/login')
      .send(loginPayload);

    expect(eleventh.status).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });

  it('returns 429 on the 11th POST /api/auth/register within the throttle window', async () => {
    const registerPayload = {
      email: `throttle-reg-${Date.now()}@example.com`,
      name: 'Throttle Tester',
      password: 'P@ssword1!',
    };

    // Send 10 requests — all should be processed (may succeed or fail with 400/409,
    // but NOT 429)
    for (let i = 0; i < 10; i++) {
      const res = await supertest(app.getHttpServer())
        .post('/api/auth/register')
        .send(registerPayload);
      expect(res.status).not.toBe(HttpStatus.TOO_MANY_REQUESTS);
    }

    // The 11th request must be rate-limited
    const eleventh = await supertest(app.getHttpServer())
      .post('/api/auth/register')
      .send(registerPayload);

    expect(eleventh.status).toBe(HttpStatus.TOO_MANY_REQUESTS);
  }, 15000);
});

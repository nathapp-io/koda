import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Boot the full API (AppFactory + real guards/pipes/filters) for HTTP-level
 * integration tests. Same wiring as test/integration/projects/project-memory.
 */
import request from 'supertest';
import { AppFactory, NathApplication } from '@nathapp/nestjs-app';
import { DefaultThrottlerGuard } from '@nathapp/nestjs-throttler';
import { AppModule } from '../../src/app.module';
import { CombinedAuthGuard } from '../../src/auth/guards/combined-auth.guard';
import { createFastifyAdapter } from '../../src/common/fastify-adapter';
import { registerRawBodyHook } from '../../src/common/hooks/raw-body.hook';
import { registerBundleContentParser, registerLogContentParser } from '../../src/common/hooks/bundle-content-parser';
import { TEST_PASSWORD } from './test-credentials';

export { TEST_PASSWORD, TEST_PASSWORD_HASH } from './test-credentials';

/**
 * Finish booting a Fastify-backed Nest application created with
 * `AppFactory.createFastifyApp`/`createFastifyAdapter`.
 *
 * `app.init()` registers every route but does NOT boot Fastify: the `preReady`
 * phase — the only moment route contexts receive their hook arrays
 * (`preParsing`, `preValidation`, ...) — runs on `ready()` or `listen()`.
 * Production boots inside `fastify.listen()` and `fastify.inject()` boots on
 * demand, but supertest binds the raw `fastify.server` directly and skips both.
 * Without this explicit `ready()`, the first supertest request crashes in
 * `preParsingHookRunner` (`preParsing` is undefined) and the socket hangs.
 */
export async function initFastifyApp(app: NathApplication): Promise<void> {
  const fastify = app.getHttpAdapter().getInstance();
  // Production bootstrap (main.ts) installs these before init(): mirror it so
  // HTTP-level tests exercise the same Fastify pipeline. Express passed any
  // content type through, but Fastify answers 415 unless a parser is
  // registered, and webhook HMAC verification needs the captured rawBody.
  registerRawBodyHook(fastify);
  registerBundleContentParser(fastify);
  registerLogContentParser(fastify);
  await app.init();
  await fastify.ready();
}

export interface HttpAppOptions {
  registrationEnabled: boolean;
  /**
   * `KODA_OWNER_EMAIL` for this boot (permissions P1a US-004): a string sets it, `null`/unset deletes
   * it, so a suite never inherits an owner email from the machine it runs on.
   */
  ownerEmail?: string | null;
  /** Serve Swagger in integration tests that assert the live API contract. */
  swagger?: boolean;
}

/**
 * Config factories read process.env during AppFactory.create, so the flags are
 * set only for the create call and restored afterwards (test files share one
 * process under maxWorkers: 1).
 */
export async function bootHttpApp(opts: HttpAppOptions): Promise<NathApplication> {
  // A KB delete now persists recovery intents even when its vector table is in memory.
  const kbRoot = mkdtempSync(join(tmpdir(), 'koda-http-kb-'));
  const previous = {
    LANCEDB_PATH: process.env.LANCEDB_PATH,
    REGISTRATION_ENABLED: process.env.REGISTRATION_ENABLED,
    KODA_OWNER_EMAIL: process.env.KODA_OWNER_EMAIL,
  };
  process.env.LANCEDB_PATH = kbRoot;
  process.env.REGISTRATION_ENABLED = String(opts.registrationEnabled);
  if (opts.ownerEmail) process.env.KODA_OWNER_EMAIL = opts.ownerEmail;
  else delete process.env.KODA_OWNER_EMAIL;
  try {
    const app = await AppFactory.createFastifyApp(AppModule, createFastifyAdapter());
    app.setJwtAuthGuard(app.get(CombinedAuthGuard));
    app.useAppGlobalPrefix().useAppGlobalPipes().useAppGlobalFilters().useAppGlobalGuards();
    if (opts.swagger) {
      app.useSwaggerUI({ name: 'Koda API', description: 'Integration-test API', version: '1.0.0' });
    }
    await initFastifyApp(app);
    const close = app.close.bind(app);
    app.close = async () => {
      try { return await close(); }
      finally { rmSync(kbRoot, { recursive: true, force: true }); }
    };
    return app;
  } catch (error) {
    rmSync(kbRoot, { recursive: true, force: true });
    throw error;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Drop the in-memory throttler hit counters: a suite that logs in more often than the 5/min login
 * limit (or registers more often than 5/min) would otherwise get 429s that have nothing to do with
 * what it asserts.
 */
export function resetThrottle(app: NathApplication): void {
  const guard = app.get(DefaultThrottlerGuard);
  const storageService = (guard as unknown as {
    storageService: {
      storage: Map<string, unknown>;
      timeoutIds?: Map<string, NodeJS.Timeout[]>;
      hitExpirations?: Map<string, unknown>;
    };
  }).storageService;
  // Cancel pending hit-expiry timers (6.5) / clear hit expirations (6.6+) before dropping the records,
  // so no callback dereferences a cleared key.
  storageService.timeoutIds?.forEach((timeouts) => timeouts.forEach(clearTimeout));
  storageService.timeoutIds?.clear();
  storageService.hitExpirations?.clear();
  storageService.storage.clear();
}

/** Unwrap JsonResponse { ret: 0, data: T } → data */
export function data<T = unknown>(res: request.Response): T {
  expect(res.body).toHaveProperty('ret', 0);
  return res.body.data as T;
}

export async function loginToken(
  server: Parameters<typeof request>[0],
  email: string,
  password: string = TEST_PASSWORD,
): Promise<string> {
  const res = await request(server).post('/api/auth/login').send({ email, password }).expect(200);
  return data<{ accessToken: string }>(res).accessToken;
}

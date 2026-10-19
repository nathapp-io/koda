/**
 * Boot the full API (AppFactory + real guards/pipes/filters) for HTTP-level
 * integration tests. Same wiring as test/integration/projects/project-memory.
 */
import request from 'supertest';
import { AppFactory, NathApplication } from '@nathapp/nestjs-app';
import { DefaultThrottlerGuard } from '@nathapp/nestjs-throttler';
import { AppModule } from '../../src/app.module';
import { CombinedAuthGuard } from '../../src/auth/guards/combined-auth.guard';

export const TEST_PASSWORD = 'Admin1234!Aa';

export interface HttpAppOptions {
  registrationEnabled: boolean;
  /**
   * `KODA_OWNER_EMAIL` for this boot (permissions P1a US-004): a string sets it, `null`/unset deletes
   * it, so a suite never inherits an owner email from the machine it runs on.
   */
  ownerEmail?: string | null;
}

/**
 * Config factories read process.env during AppFactory.create, so the flags are
 * set only for the create call and restored afterwards (test files share one
 * process under maxWorkers: 1).
 */
export async function bootHttpApp(opts: HttpAppOptions): Promise<NathApplication> {
  const previous = {
    REGISTRATION_ENABLED: process.env.REGISTRATION_ENABLED,
    KODA_OWNER_EMAIL: process.env.KODA_OWNER_EMAIL,
  };
  process.env.REGISTRATION_ENABLED = String(opts.registrationEnabled);
  if (opts.ownerEmail) process.env.KODA_OWNER_EMAIL = opts.ownerEmail;
  else delete process.env.KODA_OWNER_EMAIL;
  try {
    const app = await AppFactory.create(AppModule);
    app.setJwtAuthGuard(app.get(CombinedAuthGuard));
    app.useAppGlobalPrefix().useAppGlobalPipes().useAppGlobalFilters().useAppGlobalGuards();
    await app.init();
    return app;
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

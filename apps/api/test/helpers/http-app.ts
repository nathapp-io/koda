/**
 * Boot the full API (AppFactory + real guards/pipes/filters) for HTTP-level
 * integration tests. Same wiring as test/integration/projects/project-memory.
 */
import request from 'supertest';
import { AppFactory, NathApplication } from '@nathapp/nestjs-app';
import { AppModule } from '../../src/app.module';
import { CombinedAuthGuard } from '../../src/auth/guards/combined-auth.guard';

export const TEST_PASSWORD = 'Admin1234!Aa';

/**
 * Config factories read process.env during AppFactory.create, so the flag is
 * set only for the create call and restored afterwards (test files share one
 * process under maxWorkers: 1).
 */
export async function bootHttpApp(opts: { registrationEnabled: boolean }): Promise<NathApplication> {
  const previous = process.env.REGISTRATION_ENABLED;
  process.env.REGISTRATION_ENABLED = String(opts.registrationEnabled);
  try {
    const app = await AppFactory.create(AppModule);
    app.setJwtAuthGuard(app.get(CombinedAuthGuard));
    app.useAppGlobalPrefix().useAppGlobalPipes().useAppGlobalFilters().useAppGlobalGuards();
    await app.init();
    return app;
  } finally {
    if (previous === undefined) delete process.env.REGISTRATION_ENABLED;
    else process.env.REGISTRATION_ENABLED = previous;
  }
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

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
 * Config factories read process.env during AppFactory.create, so the flags are
 * set only for the create call and restored afterwards (test files share one
 * process under maxWorkers: 1).
 *
 * `agentProjectScoping` (S4c US-001) is omitted by most suites, which leaves the
 * default (on); pass 'off' to restore the pre-S4c agent reach.
 */
export async function bootHttpApp(opts: {
  registrationEnabled: boolean;
  agentProjectScoping?: 'on' | 'off';
}): Promise<NathApplication> {
  const previousRegistration = process.env.REGISTRATION_ENABLED;
  const previousScoping = process.env.AGENT_PROJECT_SCOPING;
  process.env.REGISTRATION_ENABLED = String(opts.registrationEnabled);
  if (opts.agentProjectScoping !== undefined) {
    process.env.AGENT_PROJECT_SCOPING = opts.agentProjectScoping;
  }
  try {
    const app = await AppFactory.create(AppModule);
    app.setJwtAuthGuard(app.get(CombinedAuthGuard));
    app.useAppGlobalPrefix().useAppGlobalPipes().useAppGlobalFilters().useAppGlobalGuards();
    await app.init();
    return app;
  } finally {
    if (previousRegistration === undefined) delete process.env.REGISTRATION_ENABLED;
    else process.env.REGISTRATION_ENABLED = previousRegistration;
    if (previousScoping === undefined) delete process.env.AGENT_PROJECT_SCOPING;
    else process.env.AGENT_PROJECT_SCOPING = previousScoping;
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

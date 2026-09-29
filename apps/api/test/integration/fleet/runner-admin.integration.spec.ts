/**
 * Fleet S1 slice 1 — runner admin routes (list, get, enable/disable, delete) over HTTP on PG.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/runner-admin.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { DefaultThrottlerGuard } from '@nathapp/nestjs-throttler';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const capabilities = {
  nax: { version: '0.83.0', protocols: ['native'] },
  sandbox: { available: true, probedAt: '2026-09-30T00:00:00.000Z' },
  profiles: {}, credentials: [], tools: { git: true, gh: true, glab: false }, executors: ['host'],
};
const enrollBody = (token: string, name: string) => ({
  enrollmentToken: token, name, os: 'linux', arch: 'x64', daemonVersion: '0.1.0',
  protocolVersion: 1, bootId: 'boot-1', labels: ['linux'], capabilities,
});

describeIntegration('fleet runner admin (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let admin: string;
  let member: string;
  let runner: { runnerId: string; apiKey: string };
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const newToken = async (labels: string[] = []) =>
    data<{ id: string; token: string }>(await request(server).post('/api/fleet/enrollments').set(auth(admin)).send({ labels }).expect(201));

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    const root = await request(server).post('/api/auth/register').send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    admin = data<{ accessToken: string }>(root).accessToken;
    await request(server).post('/api/admin/users').set(auth(admin))
      .send({ email: 'member@koda.test', name: 'member', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    member = await loginToken(server, 'member@koda.test');
    const { token } = await newToken();
    runner = data<{ runnerId: string; apiKey: string }>(
      await request(server).post('/api/fleet/runner/enroll').send(enrollBody(token, 'box-1')).expect(201),
    );
  });

  beforeEach(() => {
    // Copied from test/integration/users/admin-users.integration.spec.ts (enroll is throttled 10/min).
    const guard = app.get(DefaultThrottlerGuard);
    const storageService = (guard as unknown as {
      storageService: {
        storage: Map<string, unknown>;
        timeoutIds?: Map<string, NodeJS.Timeout[]>;
        hitExpirations?: Map<string, unknown>;
      };
    }).storageService;
    storageService.timeoutIds?.forEach((timeouts) => timeouts.forEach(clearTimeout));
    storageService.timeoutIds?.clear();
    storageService.hitExpirations?.clear();
    storageService.storage.clear();
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists and reads runners without exposing key hashes', async () => {
    const page = data<{ records: Array<Record<string, unknown>> }>(await request(server).get('/api/fleet/runners').set(auth(admin)).expect(200));
    expect(page.records).toHaveLength(1);
    expect(page.records[0]).not.toHaveProperty('apiKeyHash');
    await request(server).get(`/api/fleet/runners/${runner.runnerId}`).set(auth(admin)).expect(200);
    await request(server).get('/api/fleet/runners/nope').set(auth(admin)).expect(404);
  });

  it('forbids a non-admin user', async () => {
    await request(server).get('/api/fleet/runners').set(auth(member)).expect(403);
    await request(server).post('/api/fleet/enrollments').set(auth(member)).send({}).expect(403);
  });

  it('keeps a disabled runner authenticated (drain)', async () => {
    await request(server).patch(`/api/fleet/runners/${runner.runnerId}`).set(auth(admin)).send({ enabled: false }).expect(200);
    const me = data<{ enabled: boolean }>(await request(server).get('/api/fleet/runner/me').set(auth(runner.apiKey)).expect(200));
    expect(me.enabled).toBe(false);
  });

  it('validates the patch', async () => {
    await request(server).patch(`/api/fleet/runners/${runner.runnerId}`).set(auth(admin)).send({ capacity: 0 }).expect(400);
    await request(server).patch(`/api/fleet/runners/${runner.runnerId}`).set(auth(admin)).send({ labels: ['Bad Label'] }).expect(400);
  });

  it('revokes the key on delete', async () => {
    await request(server).delete(`/api/fleet/runners/${runner.runnerId}`).set(auth(admin)).expect(204);
    await request(server).get('/api/fleet/runner/me').set(auth(runner.apiKey)).expect(401);
  });
});

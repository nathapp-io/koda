/**
 * Fleet S1 slice 1 — enrollment and runner route isolation over HTTP on PG.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/runner-enrollment.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { DefaultThrottlerGuard } from '@nathapp/nestjs-throttler';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, TEST_PASSWORD } from '../../helpers/http-app';

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

describeIntegration('fleet enrollment (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let admin: string;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const newToken = async (labels: string[] = []) =>
    data<{ id: string; token: string }>(await request(server).post('/api/fleet/enrollments').set(auth(admin)).send({ labels }).expect(201));

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    const root = await request(server).post('/api/auth/register').send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    admin = data<{ accessToken: string }>(root).accessToken;
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

  it('enrolls once; the key works on /fleet/runner/me and nowhere else', async () => {
    const { token } = await newToken(['gpu']);
    const enrolled = data<{ runnerId: string; apiKey: string }>(
      await request(server).post('/api/fleet/runner/enroll').send(enrollBody(token, 'box-1')).expect(201),
    );
    expect(enrolled.apiKey).toMatch(/^kr_/);

    const me = data<Record<string, unknown>>(await request(server).get('/api/fleet/runner/me').set(auth(enrolled.apiKey)).expect(200));
    expect(me).toEqual({ id: enrolled.runnerId, name: 'box-1', labels: ['gpu', 'linux'], capacity: 1, enabled: true });

    await request(server).get('/api/projects').set(auth(enrolled.apiKey)).expect(401);
    // Task 8 added runners.controller.ts, so /api/fleet/runners now exists and a runner
    // key is asserted against it directly (deeper coverage in runner-admin.integration.spec.ts).
    await request(server).get('/api/fleet/runners').set(auth(enrolled.apiKey)).expect(401);
    await request(server).get('/api/fleet/activity').set(auth(enrolled.apiKey)).expect(401);
    await request(server).post('/api/fleet/runner/enroll').send(enrollBody(token, 'box-2')).expect(401);
  });

  it('answers the bad-token 401 for a non-ke_ token without consuming anything (#157)', async () => {
    const { token } = await newToken();
    await request(server).post('/api/fleet/runner/enroll').send(enrollBody(`x${token}`, 'box-bad')).expect(401);
    await request(server).post('/api/fleet/runner/enroll').send(enrollBody(token, 'box-good')).expect(201);
  });

  it('refuses user JWTs and missing credentials on runner routes', async () => {
    await request(server).get('/api/fleet/runner/me').set(auth(admin)).expect(401);
    await request(server).get('/api/fleet/runner/me').expect(401);
  });

  it('lets exactly one of two racing enrollments win', async () => {
    const { token } = await newToken();
    const results = await Promise.all([
      request(server).post('/api/fleet/runner/enroll').send(enrollBody(token, 'race-a')),
      request(server).post('/api/fleet/runner/enroll').send(enrollBody(token, 'race-b')),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 401]);
  });

  it('keeps the token usable when enrollment fails on a duplicate name', async () => {
    const { token } = await newToken();
    await request(server).post('/api/fleet/runner/enroll').send(enrollBody(token, 'box-1')).expect(409);
    await request(server).post('/api/fleet/runner/enroll').send(enrollBody(token, 'box-3')).expect(201);
  });

  it('answers 426 for an unsupported protocol and 400 for bad capabilities, leaving the token unused', async () => {
    const { token } = await newToken();
    await request(server).post('/api/fleet/runner/enroll').send({ ...enrollBody(token, 'box-4'), protocolVersion: 99 }).expect(426);
    await request(server).post('/api/fleet/runner/enroll').send({ ...enrollBody(token, 'box-4'), capabilities: { nax: 'x' } }).expect(400);
    await request(server).post('/api/fleet/runner/enroll').send(enrollBody(token, 'box-4')).expect(201);
  });

  it('rejects an expired token', async () => {
    const { id, token } = await newToken();
    const prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    await prisma.runnerEnrollment.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await request(server).post('/api/fleet/runner/enroll').send(enrollBody(token, 'box-5')).expect(401);
  });

  it('never returns token hashes in the enrollment list, and logs activity', async () => {
    const list = data<{ records: Array<Record<string, unknown>> }>(await request(server).get('/api/fleet/enrollments').set(auth(admin)).expect(200));
    expect(list.records.length).toBeGreaterThan(0);
    for (const row of list.records) {
      expect(row).not.toHaveProperty('tokenHash');
      expect(row).not.toHaveProperty('token');
    }
    const activity = data<{ records: Array<{ action: string }> }>(await request(server).get('/api/fleet/activity').set(auth(admin)).expect(200));
    expect(activity.records.map((a) => a.action)).toEqual(expect.arrayContaining(['enrollment.created', 'runner.enrolled']));
  });
});

import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
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

describeIntegration('runner route permissions (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let admin: string;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    const root = await request(server).post('/api/auth/register').send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    admin = data<{ accessToken: string }>(root).accessToken;
  });
  afterAll(async () => { await app.close(); });

  it('AC-7: enrolled runner key reads the runner identity', async () => {
    const enrollment = data<{ token: string }>(await request(server).post('/api/fleet/enrollments').set(auth(admin)).send({ labels: [] }).expect(201));
    const enrolled = data<{ apiKey: string }>(await request(server).post('/api/fleet/runner/enroll').send(enrollBody(enrollment.token, 'contract-runner')).expect(201));
    const me = data<{ name: string }>(await request(server).get('/api/fleet/runner/me').set(auth(enrolled.apiKey)).expect(200));
    expect(me.name).toBe('contract-runner');
  });

  it('AC-8: unauthenticated enrollment with a valid unused token returns a runner key', async () => {
    const enrollment = data<{ token: string }>(await request(server).post('/api/fleet/enrollments').set(auth(admin)).send({ labels: [] }).expect(201));
    const enrolled = data<{ apiKey: string }>(await request(server).post('/api/fleet/runner/enroll').send(enrollBody(enrollment.token, 'public-contract-runner')).expect(201));
    expect(enrolled.apiKey).toMatch(/^kr_/);
  });
});

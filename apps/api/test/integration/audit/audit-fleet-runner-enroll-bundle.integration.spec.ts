import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, TEST_PASSWORD } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
const capabilities = {
  nax: { version: '0.83.0', protocols: ['native'] },
  sandbox: { available: true, probedAt: '2026-09-30T00:00:00.000Z' },
  profiles: {}, credentials: [], tools: { git: true, gh: true, glab: false }, executors: ['host'],
};

describeIntegration('audit runner enrollment and bundle upload (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let admin: string;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    const root = await request(server).post('/api/auth/register').send({ email: 'audit-enroll@koda.test', name: 'Audit', password: TEST_PASSWORD }).expect(201);
    admin = data<{ accessToken: string }>(root).accessToken;
  });
  afterAll(async () => { await app.close(); });

  it('AC-1/2/3/4/12/13: attributes enrollment to the created runner and creates no entry on failure', async () => {
    const enrollment = data<{ id: string; token: string }>(await request(server).post('/api/fleet/enrollments')
      .set({ Authorization: `Bearer ${admin}` }).send({ labels: [] }).expect(201));
    const response = await request(server).post('/api/fleet/runner/enroll').send({
      enrollmentToken: enrollment.token, name: 'audit-enrolled-runner', os: 'linux', arch: 'x64',
      daemonVersion: '0.1.0', protocolVersion: 1, bootId: 'boot-1', labels: [], capabilities,
    }).expect(201);
    const result = data<{ runnerId: string }>(response);
    const rows = await prisma.auditEntry.findMany({ where: { key: 'runner.enroll', resourceId: result.runnerId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      key: 'runner.enroll', resourceType: 'fleet-runner', resourceId: result.runnerId, projectId: null,
      actorType: 'RUNNER', actorId: result.runnerId, origin: 'runner',
      summary: `enrolled from enrollment ${enrollment.id}`,
    }));
    await request(server).post('/api/fleet/runner/enroll').send({ enrollmentToken: enrollment.token, name: 'audit-reuse', os: 'linux', arch: 'x64', daemonVersion: '0.1.0', protocolVersion: 1, bootId: 'boot-1', labels: [], capabilities }).expect(401);
    expect(await prisma.auditEntry.count({ where: { key: 'runner.enroll', resourceId: result.runnerId } })).toBe(1);
  });
});

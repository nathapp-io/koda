/**
 * Slice 4 — registration gate and the bootstrap-admin race on real Postgres.
 * Each describe boots its own app: the register route is throttled to
 * 5 requests / minute per app instance.
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/auth/registration
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

function registerAll(server: Parameters<typeof request>[0], count: number) {
  return Promise.all(
    Array.from({ length: count }, (_, i) =>
      request(server).post('/api/auth/register').send({ email: `race${i}@koda.test`, name: `R${i}`, password: TEST_PASSWORD }),
    ),
  );
}

describeIntegration('registration closed (default)', () => {
  let app: NathApplication;
  let prisma: PrismaService<PrismaClient>;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports open while the user table is empty', async () => {
    const res = await request(app.getHttpServer()).get('/api/auth/registration-status').expect(200);
    expect(data<{ open: boolean }>(res)).toEqual({ open: true });
  });

  it('5 concurrent registrations on an empty DB: exactly one ADMIN, the rest 403', async () => {
    const results = await registerAll(app.getHttpServer(), 5);
    const statuses = results.map((r) => r.status).sort();

    expect(statuses).toEqual([201, 403, 403, 403, 403]);
    const users = await prisma.client.user.findMany();
    expect(users).toHaveLength(1);
    expect(users[0].role).toBe('ADMIN');
  });

  it('reports closed once a user exists', async () => {
    const res = await request(app.getHttpServer()).get('/api/auth/registration-status').expect(200);
    expect(data<{ open: boolean }>(res)).toEqual({ open: false });
  });
});

describeIntegration('registration open (REGISTRATION_ENABLED=true)', () => {
  let app: NathApplication;
  let prisma: PrismaService<PrismaClient>;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('5 concurrent registrations: all succeed, exactly one ADMIN', async () => {
    const results = await registerAll(app.getHttpServer(), 5);

    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(await prisma.client.user.count()).toBe(5);
    expect(await prisma.client.user.count({ where: { role: 'ADMIN' } })).toBe(1);
  });
});

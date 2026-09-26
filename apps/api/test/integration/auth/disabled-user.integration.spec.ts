/**
 * Slice 4 — a disabled user cannot log in, refresh, or use a fresh access token.
 * (Disabling through PATCH /admin/users, including cache invalidation for a
 * session already in use, is covered in test/integration/users.)
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/auth/disabled-user
 */
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('disabled users (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaService<PrismaClient>;
  let server: ReturnType<NathApplication['getHttpServer']>;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
    await prisma.client.user.create({
      data: { email: 'dis@koda.test', name: 'Dis', passwordHash: await bcrypt.hash(TEST_PASSWORD, 4) },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('an access token issued before the disable is rejected on first use', async () => {
    const login = await request(server).post('/api/auth/login').send({ email: 'dis@koda.test', password: TEST_PASSWORD }).expect(200);
    const { accessToken, refreshToken } = data<{ accessToken: string; refreshToken: string }>(login);

    await prisma.client.user.update({ where: { email: 'dis@koda.test' }, data: { disabled: true } });

    await request(server).get('/api/auth/me').set('Authorization', `Bearer ${accessToken}`).expect(401);
    await request(server).post('/api/auth/refresh').set('Authorization', `Bearer ${refreshToken}`).expect(401);
  });

  it('a disabled user cannot log in', async () => {
    await request(server).post('/api/auth/login').send({ email: 'dis@koda.test', password: TEST_PASSWORD }).expect(401);
  });
});

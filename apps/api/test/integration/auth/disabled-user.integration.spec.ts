import { canRunDbTests } from '../../helpers/test-environment';
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
import { PrismaClient } from '../../../src/generated/prisma/client';
import { expectBindingOnlyFixtures, grantBaseline } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, TEST_PASSWORD } from '../../helpers/http-app';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('disabled users (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaService<PrismaClient>;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let disUserId = '';

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
    const dis = await prisma.client.user.create({
      data: { email: 'dis@koda.test', name: 'Dis', passwordHash: await bcrypt.hash(TEST_PASSWORD, 4) },
    });
    disUserId = dis.id;
    // Permissions P1 US-004: the fixture principal is granted through bindings only — the member
    // baseline production writes for every user it creates.
    await grantBaseline(prisma.client, { type: 'USER', id: disUserId });
  });

  afterAll(async () => {
    await app.close();
  });

  it('fixtures grant through bindings only', async () => {
    await expectBindingOnlyFixtures(prisma.client, [{ type: 'USER', id: disUserId }]);
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

  it('logout revokes an access token that already warmed the auth-state cache', async () => {
    const email = 'logout@koda.test';
    const logout = await prisma.client.user.create({
      data: { email, name: 'Logout', passwordHash: await bcrypt.hash(TEST_PASSWORD, 4) },
    });
    // A principal this test creates gets its baseline too, but it is not a setup principal, so the
    // sentinel above does not list it.
    await grantBaseline(prisma.client, { type: 'USER', id: logout.id });

    const login = await request(server).post('/api/auth/login').send({ email, password: TEST_PASSWORD }).expect(200);
    const { accessToken } = data<{ accessToken: string }>(login);

    // Warm the 60 s per-user auth-state cache, then log out.
    await request(server).get('/api/auth/me').set('Authorization', `Bearer ${accessToken}`).expect(200);
    await request(server).post('/api/auth/logout').set('Authorization', `Bearer ${accessToken}`).expect(200);

    // Without the direct-key eviction this stays 200 under the MEMORY strategy.
    await request(server).get('/api/auth/me').set('Authorization', `Bearer ${accessToken}`).expect(401);
  });
});

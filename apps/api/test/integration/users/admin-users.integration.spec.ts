/**
 * Slice 4 — /admin/users on real Postgres over HTTP.
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/users
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { DefaultThrottlerGuard } from '@nathapp/nestjs-throttler';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

interface UserRow { id: string; email: string; role: string; disabled: boolean }

describeIntegration('/admin/users (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaService<PrismaClient>;
  let rootToken: string;
  let rootId: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  // Login is throttled to 5/min per app instance (H2) and this suite performs
  // more logins than that within the 60 s window, so clear the in-memory
  // throttler hit counters between tests.
  let resetThrottle: () => void;
  const createUser = async (email: string, role: 'MEMBER' | 'ADMIN' = 'MEMBER') =>
    data<UserRow>(
      await request(server).post('/api/admin/users').set(auth(rootToken))
        .send({ email, name: email.split('@')[0], password: TEST_PASSWORD, role }).expect(201),
    );

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
    // The in-memory ThrottlerStorageService is held (protected) by the global
    // DefaultThrottlerGuard; reach it through the guard instance.
    const guard = app.get(DefaultThrottlerGuard);
    const storageService = (guard as unknown as {
      storageService: {
        storage: Map<string, unknown>;
        timeoutIds?: Map<string, NodeJS.Timeout[]>;
        hitExpirations?: Map<string, unknown>;
      };
    }).storageService;
    resetThrottle = () => {
      // Cancel pending hit-expiry timers (6.5) / clear hit expirations (6.6+)
      // before dropping the records, so no callback dereferences a cleared key.
      storageService.timeoutIds?.forEach((timeouts) => timeouts.forEach(clearTimeout));
      storageService.timeoutIds?.clear();
      storageService.hitExpirations?.clear();
      storageService.storage.clear();
    };
    const res = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    rootToken = data<{ accessToken: string; user: { id: string } }>(res).accessToken;
    rootId = data<{ user: { id: string } }>(res).user.id;
  });

  beforeEach(() => {
    resetThrottle();
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates a user (email canonicalised) without leaking the hash; duplicate casing is 409', async () => {
    const created = await createUser('Alice@Koda.test');
    expect(created).toEqual(expect.objectContaining({ email: 'alice@koda.test', role: 'MEMBER', disabled: false }));
    expect(created).not.toHaveProperty('passwordHash');

    // Exact and case-variant duplicates both conflict: the plain unique index
    // alone would let the case variant through.
    await request(server).post('/api/admin/users').set(auth(rootToken))
      .send({ email: 'alice@koda.test', name: 'A2', password: TEST_PASSWORD, role: 'MEMBER' }).expect(409);
    await request(server).post('/api/admin/users').set(auth(rootToken))
      .send({ email: 'ALICE@KODA.TEST', name: 'A3', password: TEST_PASSWORD, role: 'MEMBER' }).expect(409);
  });

  it('a MEMBER cannot use the admin routes (and login is case-insensitive)', async () => {
    const token = await loginToken(server, 'ALICE@KODA.TEST');
    await request(server).get('/api/admin/users').set(auth(token)).expect(403);
  });

  it('lists with a case-insensitive email filter and paging', async () => {
    await createUser('bob1@koda.test');
    await createUser('BOB2@koda.test');
    const res = await request(server).get('/api/admin/users').query({ email: 'bob', size: '1' }).set(auth(rootToken)).expect(200);
    const page = data<{ total: number; hasNext: boolean; records: UserRow[] }>(res);
    expect(page.total).toBe(2);
    expect(page.records).toHaveLength(1);
    expect(page.hasNext).toBe(true);
  });

  it('disabling kills a session that is already in use (cached state)', async () => {
    const carol = await createUser('carol@koda.test');
    const token = await loginToken(server, 'carol@koda.test');
    await request(server).get('/api/auth/me').set(auth(token)).expect(200);

    await request(server).patch(`/api/admin/users/${carol.id}`).set(auth(rootToken)).send({ disabled: true }).expect(200);

    await request(server).get('/api/auth/me').set(auth(token)).expect(401);
    await request(server).post('/api/auth/login').send({ email: 'carol@koda.test', password: TEST_PASSWORD }).expect(401);

    await request(server).patch(`/api/admin/users/${carol.id}`).set(auth(rootToken)).send({ disabled: false }).expect(200);
    await loginToken(server, 'carol@koda.test');
  });

  it('demoting an admin revokes their ADMIN token immediately', async () => {
    const dave = await createUser('dave@koda.test', 'ADMIN');
    const daveToken = await loginToken(server, 'dave@koda.test');
    await request(server).get('/api/admin/users').set(auth(daveToken)).expect(200);

    await request(server).patch(`/api/admin/users/${dave.id}`).set(auth(rootToken)).send({ role: 'MEMBER' }).expect(200);

    await request(server).get('/api/admin/users').set(auth(daveToken)).expect(401);
  });

  it('an admin cannot demote or disable themselves', async () => {
    await request(server).patch(`/api/admin/users/${rootId}`).set(auth(rootToken)).send({ disabled: true }).expect(403);
    await request(server).patch(`/api/admin/users/${rootId}`).set(auth(rootToken)).send({ role: 'MEMBER' }).expect(403);
  });

  it('two admins demoting each other at once leave exactly one active admin', async () => {
    const eve = await createUser('eve@koda.test', 'ADMIN');
    const eveToken = await loginToken(server, 'eve@koda.test');
    // Root and Eve are the only active admins (Dave was demoted above).
    expect(await prisma.client.user.count({ where: { role: 'ADMIN', disabled: false } })).toBe(2);

    const [a, b] = await Promise.all([
      request(server).patch(`/api/admin/users/${eve.id}`).set(auth(rootToken)).send({ role: 'MEMBER' }),
      request(server).patch(`/api/admin/users/${rootId}`).set(auth(eveToken)).send({ role: 'MEMBER' }),
    ]);

    // The loser is refused: 409 (lost the locked count) or 401 (its token was
    // revoked by the winner before its request authenticated).
    expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
    expect([a.status, b.status].every((s) => [200, 401, 409].includes(s))).toBe(true);
    expect(await prisma.client.user.count({ where: { role: 'ADMIN', disabled: false } })).toBe(1);
  });
});

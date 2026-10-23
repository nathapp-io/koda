/**
 * Slice 4 — /admin/users on real Postgres over HTTP.
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/users
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { DefaultThrottlerGuard } from '@nathapp/nestjs-throttler';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

/** `users.lastAdmin.409`, the sentence the concurrent last-admin refusal carries. */
const LAST_ADMIN_REFUSED = (
  JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en/users.json'), 'utf8')) as {
    lastAdmin: Record<string, string>;
  }
).lastAdmin['409'] as string;

interface UserRow { id: string; email: string; disabled: boolean }

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
  /**
   * Permissions P1l (US-005): the create route takes no role, so `'ADMIN'` means "create a plain
   * member, then bind the global `admin` role" — the binding is the admin, and it mirrors
   * `User.role = 'ADMIN'` as the route used to.
   */
  const createUser = async (email: string, role: 'MEMBER' | 'ADMIN' = 'MEMBER'): Promise<UserRow> => {
    const created = data<UserRow>(
      await request(server).post('/api/admin/users').set(auth(rootToken))
        .send({ email, name: email.split('@')[0], password: TEST_PASSWORD }).expect(201),
    );
    if (role === 'ADMIN') await grantRole(prisma.client, { type: 'USER', id: created.id }, 'admin');
    return created;
  };

  /** The user's global `admin` binding id, for a demotion through the role-binding route. */
  const adminBindingId = async (userId: string): Promise<string> =>
    (await prisma.client.roleBinding.findFirstOrThrow({
      where: { principalType: 'USER', principalId: userId, projectId: null, role: { key: 'admin' } },
      select: { id: true },
    })).id;

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
    expect(created).toEqual(expect.objectContaining({ email: 'alice@koda.test', disabled: false }));
    expect(created).not.toHaveProperty('role');
    expect(created).not.toHaveProperty('passwordHash');

    // Exact and case-variant duplicates both conflict: the plain unique index
    // alone would let the case variant through.
    await request(server).post('/api/admin/users').set(auth(rootToken))
      .send({ email: 'alice@koda.test', name: 'A2', password: TEST_PASSWORD }).expect(409);
    await request(server).post('/api/admin/users').set(auth(rootToken))
      .send({ email: 'ALICE@KODA.TEST', name: 'A3', password: TEST_PASSWORD }).expect(409);
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
    expect(page.records.every((record) => !Object.hasOwn(record, 'role'))).toBe(true);
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

  /**
   * Permissions P1l (US-005): demoting is the `DELETE` of the target's global `admin` binding, not a
   * patch. The demotion is what revokes the target's token, so the old token stops working at once.
   */
  it('demoting an admin revokes their ADMIN token immediately', async () => {
    const dave = await createUser('dave@koda.test', 'ADMIN');
    const daveToken = await loginToken(server, 'dave@koda.test');
    const me = data<{ role: string }>(await request(server).get('/api/auth/me').set(auth(daveToken)).expect(200));
    expect(me.role).toBe('ADMIN');
    await request(server).get('/api/admin/users').set(auth(daveToken)).expect(200);

    // A legacy role patch changes nothing: `disabled` is the only patch field.
    await request(server).patch(`/api/admin/users/${dave.id}`).set(auth(rootToken)).send({ role: 'MEMBER' }).expect(200);
    await request(server).get('/api/admin/users').set(auth(daveToken)).expect(200);

    await request(server).delete(`/api/role-bindings/${await adminBindingId(dave.id)}`)
      .set(auth(rootToken)).expect(204);

    await request(server).get('/api/admin/users').set(auth(daveToken)).expect(401);
  });

  it('an admin cannot disable themselves, but a legacy role patch is a no-op 200', async () => {
    await request(server).patch(`/api/admin/users/${rootId}`).set(auth(rootToken)).send({ disabled: true }).expect(403);
    // US-005: with `role` gone from the patch, this changes nothing, so it is not a refusal.
    await request(server).patch(`/api/admin/users/${rootId}`).set(auth(rootToken)).send({ role: 'MEMBER' }).expect(200);
  });

  it('two admins disabling each other at once refuse exactly one with users.lastAdmin', async () => {
    const eve = await createUser('eve@koda.test', 'ADMIN');
    const eveToken = await loginToken(server, 'eve@koda.test');
    // Root and Eve are the only active admins (Dave was demoted above).
    expect(await prisma.client.user.count({ where: { role: 'ADMIN', disabled: false } })).toBe(2);

    const [a, b] = await Promise.all([
      request(server).patch(`/api/admin/users/${eve.id}`).set(auth(rootToken)).send({ disabled: true }),
      request(server).patch(`/api/admin/users/${rootId}`).set(auth(eveToken)).send({ disabled: true }),
    ]);

    // The lock serializes the two: the second one counts the first one's disable as done and refuses.
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a.body.ret, b.body.ret].filter((code) => code === 409)).toHaveLength(1);
    expect([a.body.message, b.body.message]).toContain(LAST_ADMIN_REFUSED);
    expect(await prisma.client.user.count({ where: { role: 'ADMIN', disabled: false } })).toBe(1);
  });
});

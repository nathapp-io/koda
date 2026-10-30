import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Slice 4 — /admin/users on real Postgres over HTTP.
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/users
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { DefaultThrottlerGuard } from '@nathapp/nestjs-throttler';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { GlobalLock, KODA_LOCK_CLASS } from '../../../src/common/utils/advisory-lock';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

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
  let prisma: PrismaClient;
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
  const createUser = async (email: string, admin = false): Promise<UserRow> => {
    const created = data<UserRow>(
      await request(server).post('/api/admin/users').set(auth(rootToken))
        .send({ email, name: email.split('@')[0], password: TEST_PASSWORD }).expect(201),
    );
    if (admin) await grantRole(prisma, { type: 'USER', id: created.id }, 'admin');
    return created;
  };

  /** The user's global `admin` binding id, for a demotion through the role-binding route. */
  const adminBindingId = async (userId: string): Promise<string> =>
    (await prisma.roleBinding.findFirstOrThrow({
      where: { principalType: 'USER', principalId: userId, projectId: null, role: { key: 'admin' } },
      select: { id: true },
    })).id;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
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

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
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
    const dave = await createUser('dave@koda.test', true);
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

  const enabledAdminCount = async () => {
    const bindings = await prisma.roleBinding.findMany({
      where: { principalType: 'USER', projectId: null, role: { key: { in: ['owner', 'admin'] } } },
      select: { principalId: true },
    });
    return prisma.user.count({ where: { disabled: false, id: { in: bindings.map(row => row.principalId) } } });
  };

  /**
   * How many backends hold (granted) or wait on the transaction-scoped advisory lock the last-admin
   * check takes (`PrismaUsersRepository.lockUserAdministration`).
   */
  const lastAdminLockBackends = async (granted: boolean): Promise<number> => {
    const rows = await prisma.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_locks
      WHERE locktype = 'advisory' AND granted = ${granted} AND objsubid = 2
        AND classid = ${KODA_LOCK_CLASS.GLOBAL}::int4 AND objid = ${GlobalLock.USER_ADMINISTRATION}::int4
    `;
    return rows[0]?.count ?? 0;
  };

  /** Polls until at least `expected` backends are in that state; fails loudly instead of hanging. */
  const waitForLastAdminLock = async (granted: boolean, expected: number, what: string): Promise<void> => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if ((await lastAdminLockBackends(granted)) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  /**
   * The last-admin rule is only reachable under concurrency (with one active admin left, the only
   * caller who could disable them is themselves, which is 403 `users.self`), so this race is the one
   * place it is exercised. Held deterministically: the test takes the advisory lock first, so both
   * requests finish their own reads and queue on it; whichever wins then commits and the other counts
   * that disable as done and refuses with `users.lastAdmin`. Without the barrier the loser can instead
   * be refused by authentication — its own `disabled` bump lands between the guard and the command's
   * reload — which is also correct, but it would hide a lock that stopped serializing.
   */
  it('two admins disabling each other at once refuse exactly one with users.lastAdmin', async () => {
    const eve = await createUser('eve@koda.test', true);
    const eveToken = await loginToken(server, 'eve@koda.test');
    // Root and Eve are the only active admins (Dave was demoted above).
    expect(await enabledAdminCount()).toBe(2);

    let release = (): void => {};
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(` +
          `${KODA_LOCK_CLASS.GLOBAL}::int4, ${GlobalLock.USER_ADMINISTRATION}::int4)) AS l`,
      );
      await barrier;
    }, { maxWait: 20_000, timeout: 60_000 });
    holder.catch(() => undefined);

    try {
      await waitForLastAdminLock(true, 1, 'the test to hold the last-admin lock');

      const pending = Promise.all([
        request(server).patch(`/api/admin/users/${eve.id}`).set(auth(rootToken)).send({ disabled: true }),
        request(server).patch(`/api/admin/users/${rootId}`).set(auth(eveToken)).send({ disabled: true }),
      ]);
      pending.catch(() => undefined);

      await waitForLastAdminLock(false, 2, 'both writes to queue on the last-admin lock');
      release();

      const [a, b] = await pending;
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect([a.body.ret, b.body.ret].filter((code) => code === 409)).toHaveLength(1);
      expect([a.body.message, b.body.message]).toContain(LAST_ADMIN_REFUSED);
      expect(await enabledAdminCount()).toBe(1);
    } finally {
      release();
      await holder.catch(() => undefined);
    }
  }, 20_000);

  /**
   * The gated write rebuilds its principal from the action context, so it reads the user row after the
   * guard let the request in. A disable that lands in between — here written straight to the table, so
   * the 60 s auth-state cache still says "enabled" and the guard passes — is the caller's session
   * ending, and it answers the same 401 the guard gives rather than an unmapped 500.
   */
  it('a caller disabled after the guard answered is refused with 401, not a server error', async () => {
    // The mutual disable above may have left root disabled; re-enable it and take a fresh token.
    await prisma.user.update({ where: { id: rootId }, data: { disabled: false } });
    const rootAgain = await loginToken(server, 'root@koda.test');
    const frank = data<UserRow>(
      await request(server).post('/api/admin/users').set(auth(rootAgain))
        .send({ email: 'frank@koda.test', name: 'frank', password: TEST_PASSWORD }).expect(201),
    );
    await grantRole(prisma, { type: 'USER', id: frank.id }, 'admin');
    const frankToken = await loginToken(server, 'frank@koda.test');
    await request(server).get('/api/admin/users').set(auth(frankToken)).expect(200);

    await prisma.user.update({ where: { id: frank.id }, data: { disabled: true } });

    const refused = await request(server).patch(`/api/admin/users/${rootId}`).set(auth(frankToken)).send({ role: 'MEMBER' });
    expect(refused.status).toBe(401);
    await request(server).get('/api/admin/users').set(auth(rootAgain)).expect(200);

    await prisma.roleBinding.deleteMany({ where: { principalType: 'USER', principalId: frank.id } });
    await prisma.user.delete({ where: { id: frank.id } });
  });
});

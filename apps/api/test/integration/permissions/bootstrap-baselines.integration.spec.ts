/**
 * Permissions P1a US-004 — owner bootstrap and baseline bindings over real HTTP + Postgres
 * (AC-5 .. AC-23, AC-26).
 *
 * Three describes, because each needs its own `KODA_OWNER_EMAIL` / `REGISTRATION_ENABLED` pair, which
 * is read once at `AppFactory.create`:
 *  - no owner email configured;
 *  - an owner email that refuses the first non-owner registration;
 *  - the installation's Owner running the admin user and agent routes.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/bootstrap-baselines.integration.spec.ts
 */
import request from 'supertest';
import { CommonExceptionCode } from '@nathapp/nestjs-common';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const OWNER_EMAIL = 'owner@koda.test';
/** Booting `AppModule` runs the system-role seeder, so the first hook needs a generous budget. */
const BOOT_TIMEOUT_MS = 30_000;

interface UserRow {
  id: string;
  email: string;
  role: string;
  disabled: boolean;
}

/** One binding of a principal, with the role key it grants. */
interface BoundRole {
  roleKey: string;
  projectId: string | null;
}

/** A booted app plus the reads and calls these ACs share. */
function harness(app: NathApplication) {
  const server: ReturnType<NathApplication['getHttpServer']> = app.getHttpServer();
  const prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
  const db = prisma.client as PrismaClient;

  const register = (email: string) =>
    request(server)
      .post('/api/auth/register')
      .send({ email, name: email.split('@')[0], password: TEST_PASSWORD });

  /** Every binding the principal holds, project-scoped or not. */
  const boundRoles = async (principalType: 'USER' | 'AGENT', principalId: string): Promise<BoundRole[]> => {
    const rows = await db.roleBinding.findMany({
      where: { principalType, principalId },
      include: { role: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({ roleKey: row.role.key, projectId: row.projectId }));
  };

  const storedRole = async (id: string): Promise<string> =>
    (await db.user.findUniqueOrThrow({ where: { id } })).role;

  const userByEmail = (email: string) => db.user.findFirstOrThrow({ where: { email } });

  return { server, db, register, boundRoles, storedRole, userByEmail };
}

describeIntegration('registration with no owner email configured (US-004)', () => {
  let app: NathApplication;
  let h: ReturnType<typeof harness>;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    h = harness(app);
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetThrottle(app);
  });

  it('AC-5: the first registration gets a projectId-null owner binding and a projectId-null member binding', async () => {
    const res = await h.register('first@koda.test');

    expect(res.status).toBe(201);
    const created = data<{ user: UserRow }>(res);

    const bindings = await h.boundRoles('USER', created.user.id);
    expect(bindings).toHaveLength(2);
    expect(bindings).toEqual(
      expect.arrayContaining([
        { roleKey: 'owner', projectId: null },
        { roleKey: 'member', projectId: null },
      ]),
    );
  });

  it('AC-6: with users already present a new registration gets a member binding and no owner binding', async () => {
    await h.register('second@koda.test').expect(201);

    const res = await h.register('third@koda.test');

    expect(res.status).toBe(201);
    const created = data<{ user: UserRow }>(res);
    expect(await h.boundRoles('USER', created.user.id)).toEqual([{ roleKey: 'member', projectId: null }]);
  });
});

describeIntegration('KODA_OWNER_EMAIL gates the first registration (US-004)', () => {
  let app: NathApplication;
  let h: ReturnType<typeof harness>;

  beforeAll(async () => {
    await resetDb();
    // Closed registration: the bootstrap path, where exactly one user is admitted.
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: OWNER_EMAIL });
    h = harness(app);
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetThrottle(app);
  });

  it('AC-8: a refused first registration leaves the users table empty', async () => {
    await h.register('other@koda.test').expect(403);

    expect(await h.db.user.count()).toBe(0);
  });

  it('AC-7: the refusal answers 403 with the registration gate', async () => {
    const res = await h.register('other@koda.test');

    expect(res.status).toBe(403);
    // `ForbiddenAppException({}, 'registration')` translates `registration.40003`.
    expect(res.body.ret).toBe(CommonExceptionCode.FORBIDDEN);
    expect(String(res.body.message)).toContain('Registration is closed');
  });

  it("AC-9: the configured owner email registers with the route's existing 201", async () => {
    const res = await h.register('Owner@Koda.test');

    expect(res.status).toBe(201);
    expect(data<{ user: UserRow }>(res).user.email).toBe(OWNER_EMAIL);
  });

  it('AC-10: the owner registration gives the created user an owner binding', async () => {
    // Registered by AC-9 (same app, same database); read back by its canonical email.
    const owner = await h.userByEmail(OWNER_EMAIL);

    expect(await h.boundRoles('USER', owner.id)).toContainEqual({ roleKey: 'owner', projectId: null });
  });
});

describeIntegration('admin user and agent routes as the Owner (US-004)', () => {
  let app: NathApplication;
  let h: ReturnType<typeof harness>;
  let rootToken: string;
  let rootId: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const createUser = async (email: string, role: 'MEMBER' | 'ADMIN' = 'MEMBER'): Promise<UserRow> =>
    data<UserRow>(
      await request(h.server)
        .post('/api/admin/users')
        .set(auth(rootToken))
        .send({ email, name: email.split('@')[0], password: TEST_PASSWORD, role })
        .expect(201),
    );

  const patchUser = (id: string, patch: Record<string, unknown>) =>
    request(h.server).patch(`/api/admin/users/${id}`).set(auth(rootToken)).send(patch);

  /** Gives the user a projectId-null `owner` binding, as an installation Owner holds. */
  const grantOwner = async (userId: string): Promise<void> => {
    const ownerRole = await h.db.role.findUniqueOrThrow({ where: { key: 'owner' } });
    await h.db.roleBinding.create({
      data: {
        principalType: 'USER',
        principalId: userId,
        roleId: ownerRole.id,
        projectId: null,
        grantedByType: 'SYSTEM',
        grantedById: 'test',
      },
    });
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: OWNER_EMAIL });
    h = harness(app);
    // Setup, not an assertion: the whole describe acts as the installation's Owner.
    const res = await h.register(OWNER_EMAIL).expect(201);
    const session = data<{ accessToken: string; user: UserRow }>(res);
    rootToken = session.accessToken;
    rootId = session.user.id;
  }, BOOT_TIMEOUT_MS);

  beforeEach(() => {
    resetThrottle(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('AC-11: an admin-created MEMBER gets a member binding and no admin binding', async () => {
    const created = await createUser('member@koda.test');

    expect(await h.boundRoles('USER', created.id)).toEqual([{ roleKey: 'member', projectId: null }]);
  });

  it('AC-12: an admin-created ADMIN gets a projectId-null admin binding', async () => {
    const created = await createUser('admin@koda.test', 'ADMIN');

    expect(await h.boundRoles('USER', created.id)).toContainEqual({ roleKey: 'admin', projectId: null });
  });

  it('AC-13: an admin-created ADMIN stores User.role ADMIN', async () => {
    const created = await createUser('admin2@koda.test', 'ADMIN');

    expect(await h.storedRole(created.id)).toBe('ADMIN');
  });

  it('AC-14: demoting an admin removes the admin binding (a second active admin exists)', async () => {
    const target = await createUser('demoted@koda.test', 'ADMIN');

    await patchUser(target.id, { role: 'MEMBER' }).expect(200);

    expect(await h.boundRoles('USER', target.id)).toEqual([{ roleKey: 'member', projectId: null }]);
  });

  it('AC-15: demoting an admin stores User.role MEMBER', async () => {
    const target = await createUser('demoted2@koda.test', 'ADMIN');
    await patchUser(target.id, { role: 'MEMBER' }).expect(200);

    expect(await h.storedRole(target.id)).toBe('MEMBER');
  });

  it('AC-16: demoting the last active admin answers the existing last-admin error', async () => {
    const target = await createUser('last-admin@koda.test', 'ADMIN');
    // Make the target the only active admin: the acting Owner must not count for the guard. The
    // direct write leaves `tokenVersion` alone, so the Owner's own token stays valid.
    await h.db.user.update({ where: { id: rootId }, data: { role: 'MEMBER' } });
    try {
      const res = await patchUser(target.id, { role: 'MEMBER' });

      expect(res.status).toBe(409);
      // `ConflictAppException({}, 'users.lastAdmin')` translates `users.lastAdmin.409`.
      expect(String(res.body.message)).toContain('At least one active administrator must remain');
    } finally {
      await h.db.user.update({ where: { id: rootId }, data: { role: 'ADMIN' } });
    }
  });

  it("AC-17: the refused demotion leaves the target's admin binding in place", async () => {
    const target = await createUser('last-admin2@koda.test', 'ADMIN');
    await h.db.user.update({ where: { id: rootId }, data: { role: 'MEMBER' } });
    try {
      await patchUser(target.id, { role: 'MEMBER' }).expect(409);
    } finally {
      await h.db.user.update({ where: { id: rootId }, data: { role: 'ADMIN' } });
    }

    expect(await h.boundRoles('USER', target.id)).toContainEqual({ roleKey: 'admin', projectId: null });
  });

  it('AC-18: POST /agents gives the new agent a projectId-null agent binding', async () => {
    const res = await request(h.server)
      .post('/api/agents')
      .set(auth(rootToken))
      .send({ name: 'Bound Agent', slug: 'bound-agent', roles: ['DEVELOPER'], capabilities: ['typescript'] });

    expect(res.status).toBe(201);
    const created = data<{ agent: { id: string } }>(res);

    expect(await h.boundRoles('AGENT', created.agent.id)).toEqual([{ roleKey: 'agent', projectId: null }]);
  });

  it('AC-19: DELETE /agents/:slug leaves no AGENT binding for that agent', async () => {
    const res = await request(h.server)
      .post('/api/agents')
      .set(auth(rootToken))
      .send({ name: 'Doomed Agent', slug: 'doomed-agent', roles: ['DEVELOPER'] });
    expect(res.status).toBe(201);
    const agentId = data<{ agent: { id: string } }>(res).agent.id;

    await request(h.server).delete('/api/agents/doomed-agent').set(auth(rootToken)).expect(200);

    expect(await h.db.roleBinding.count({ where: { principalType: 'AGENT', principalId: agentId } })).toBe(0);
  });

  it('AC-20: demoting an admin revokes their earlier access token', async () => {
    const target = await createUser('token-user@koda.test', 'ADMIN');
    const token = await loginToken(h.server, 'token-user@koda.test');
    await request(h.server).get('/api/auth/me').set(auth(token)).expect(200);

    await patchUser(target.id, { role: 'MEMBER' }).expect(200);

    await request(h.server).get('/api/auth/me').set(auth(token)).expect(401);
  });

  it('AC-21: demoting a user who holds owner and admin bindings leaves only the owner binding', async () => {
    const target = await createUser('owner-admin@koda.test', 'ADMIN');
    await grantOwner(target.id);

    await patchUser(target.id, { role: 'MEMBER' }).expect(200);

    // Of the two global admin roles, only `owner` survives; the baseline `member` is untouched.
    const bindings = await h.boundRoles('USER', target.id);
    expect(bindings).toHaveLength(2);
    expect(bindings).toContainEqual({ roleKey: 'owner', projectId: null });
    expect(bindings).toContainEqual({ roleKey: 'member', projectId: null });
  });

  it('AC-22: an Owner keeps User.role ADMIN after the admin binding is removed', async () => {
    const target = await createUser('owner-admin2@koda.test', 'ADMIN');
    await grantOwner(target.id);

    await patchUser(target.id, { role: 'MEMBER' }).expect(200);

    expect(await h.storedRole(target.id)).toBe('ADMIN');
  });

  it('AC-23: demoting a legacy ADMIN that holds no binding stores User.role MEMBER', async () => {
    const legacy = await h.db.user.create({
      data: { email: 'legacy-admin@koda.test', name: 'Legacy', passwordHash: 'not-a-real-hash', role: 'ADMIN' },
    });
    expect(await h.boundRoles('USER', legacy.id)).toEqual([]);

    await patchUser(legacy.id, { role: 'MEMBER' }).expect(200);

    expect(await h.storedRole(legacy.id)).toBe('MEMBER');
  });

  it('AC-26: disabling a user without a role change still revokes their session', async () => {
    const target = await createUser('disabled-user@koda.test');
    const token = await loginToken(h.server, 'disabled-user@koda.test');
    await request(h.server).get('/api/auth/me').set(auth(token)).expect(200);

    await patchUser(target.id, { disabled: true }).expect(200);

    await request(h.server).get('/api/auth/me').set(auth(token)).expect(401);
  });
});

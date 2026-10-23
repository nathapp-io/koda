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
import { MembershipService } from '../../../src/permissions/membership.service';
import { PrismaUsersRepository } from '../../../src/users/prisma-users.repository';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
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

  const userByEmail = (email: string) => db.user.findFirstOrThrow({ where: { email } });

  /**
   * Empty the user-facing tables without touching the seeded `Role` rows, so a test that needs the
   * empty-table bootstrap starts from it whatever ran before. `RoleBinding.principalId` has no foreign
   * key, so bindings are cleared first.
   */
  const emptyPrincipalTables = async (): Promise<void> => {
    await db.roleBinding.deleteMany({});
    await db.user.deleteMany({});
  };

  return { server, db, register, boundRoles, userByEmail, emptyPrincipalTables };
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
    // The Owner seat is only free on an empty table, so the test clears it rather than relying on
    // whatever another test left behind.
    await h.emptyPrincipalTables();

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
    await h.emptyPrincipalTables();
    await h.register('second@koda.test').expect(201);

    const res = await h.register('third@koda.test');

    expect(res.status).toBe(201);
    const created = data<{ user: UserRow }>(res);
    expect(await h.boundRoles('USER', created.user.id)).toEqual([{ roleKey: 'member', projectId: null }]);
  });

  it('B4: a failed Owner binding rolls the registration back instead of spending the Owner seat', async () => {
    await h.emptyPrincipalTables();
    // No `owner` role row: the first user's Owner binding cannot be written. Leaving the user committed
    // would answer an error and consume the only seat an Owner can ever take (firstUser is then false).
    const owner = await h.db.role.findUniqueOrThrow({ where: { key: 'owner' } });
    await h.db.role.delete({ where: { key: 'owner' } });

    try {
      const res = await h.register('bootstrap@koda.test');

      expect(res.status).toBe(404);
      expect(await h.db.user.count()).toBe(0);
    } finally {
      await h.db.role.create({
        data: {
          id: owner.id,
          key: owner.key,
          name: owner.name,
          description: owner.description,
          scope: owner.scope,
          system: owner.system,
          locked: owner.locked,
          permissions: owner.permissions as Prisma.InputJsonValue,
        },
      });
    }

    // The seat is still free: the next registration bootstraps the Owner as it would on a fresh install.
    const retry = await h.register('first@koda.test');

    expect(retry.status).toBe(201);
    const created = data<{ user: UserRow }>(retry);
    expect(await h.boundRoles('USER', created.user.id)).toContainEqual({ roleKey: 'owner', projectId: null });
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

  /**
   * The state every case in this describe needs: an empty users table, then the Owner's registration
   * attempt, which is the only one the gate lets through. Each case builds it itself so the assertions
   * do not depend on another test having run.
   */
  const registerOwnerFromEmptyTable = () => h.emptyPrincipalTables().then(() => h.register(OWNER_EMAIL));

  it('AC-8: a refused first registration leaves the users table empty', async () => {
    await h.emptyPrincipalTables();

    await h.register('other@koda.test').expect(403);

    expect(await h.db.user.count()).toBe(0);
  });

  it('AC-7: the refusal answers 403 with the registration gate', async () => {
    await h.emptyPrincipalTables();

    const res = await h.register('other@koda.test');

    expect(res.status).toBe(403);
    // `ForbiddenAppException({}, 'registration')` translates `registration.40003`.
    expect(res.body.ret).toBe(CommonExceptionCode.FORBIDDEN);
    expect(String(res.body.message)).toContain('Registration is closed');
  });

  it("AC-9: the configured owner email registers with the route's existing 201", async () => {
    const res = await registerOwnerFromEmptyTable();

    expect(res.status).toBe(201);
    expect(data<{ user: UserRow }>(res).user.email).toBe(OWNER_EMAIL);
  });

  it('AC-10: the owner registration gives the created user an owner binding', async () => {
    const res = await registerOwnerFromEmptyTable();
    // Precondition of this AC: the owner's registration is the one the gate lets through.
    expect(res.status).toBe(201);

    const owner = await h.userByEmail(OWNER_EMAIL);

    expect(await h.boundRoles('USER', owner.id)).toContainEqual({ roleKey: 'owner', projectId: null });
  });
});

describeIntegration('admin user and agent routes as the Owner (US-004)', () => {
  let app: NathApplication;
  let h: ReturnType<typeof harness>;
  let rootToken: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /**
   * Permissions P1l (US-005): the create route takes no role, so `'ADMIN'` means "create a plain
   * member, then bind the global `admin` role" — the binding is the admin, and it mirrors
   * `User.role = 'ADMIN'` as the route used to.
   */
  const createUser = async (email: string, admin = false): Promise<UserRow> => {
    const created = data<UserRow>(
      await request(h.server)
        .post('/api/admin/users')
        .set(auth(rootToken))
        .send({ email, name: email.split('@')[0], password: TEST_PASSWORD })
        .expect(201),
    );
    if (admin) await grantRole(h.db, { type: 'USER', id: created.id }, 'admin');
    return created;
  };

  /** The user's global `admin` binding id, for a demotion through the role-binding route. */
  const adminBindingId = async (userId: string): Promise<string> =>
    (await h.db.roleBinding.findFirstOrThrow({
      where: { principalType: 'USER', principalId: userId, projectId: null, role: { key: 'admin' } },
      select: { id: true },
    })).id;

  const patchUser = (id: string, patch: Record<string, unknown>) =>
    request(h.server).patch(`/api/admin/users/${id}`).set(auth(rootToken)).send(patch);

  /** Count enabled users with global owner/admin bindings, as the guard does. */
  const activeAdminCount = () => app.get(PrismaUsersRepository).countActiveAdmins();

  /** Temporarily withdraw all other privileged bindings, without changing mirrors or tokens. */
  const withOnlyActiveAdmin = async (targetId: string, fn: (token: string) => Promise<void>): Promise<void> => {
    const actor = await createUser(`updater-${targetId}@koda.test`);
    const role = await h.db.role.create({ data: {
      key: `updater-${targetId}`, name: 'Updater', scope: 'GLOBAL', permissions: ['user.update'],
    } });
    await grantRole(h.db, { type: 'USER', id: actor.id }, role.key);
    resetThrottle(app);
    const token = await loginToken(h.server, actor.email);
    const where = { principalType: 'USER', principalId: { not: targetId }, projectId: null,
      role: { key: { in: ['owner', 'admin'] } } };
    const others = await h.db.roleBinding.findMany({ where, take: 5000 });
    await h.db.roleBinding.deleteMany({ where });
    await app.get(MembershipService).invalidatePermissions();
    try {
      await fn(token);
    } finally {
      await h.db.roleBinding.createMany({ data: others });
      await app.get(MembershipService).invalidatePermissions();
    }
  };

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
    rootToken = data<{ accessToken: string }>(res).accessToken;
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

  /**
   * Permissions P1l (US-005) supersedes US-004's AC-12 and AC-13: the create request has no role any
   * more, so a body that still sends `role: ADMIN` is stripped and the account is a plain member.
   */
  it('AC-12: a create that sends { role: ADMIN } gets only the member baseline', async () => {
    // Sent straight at the route: `createUser`'s `'ADMIN'` means "bind the admin role", which is not
    // what this case is about.
    const created = data<UserRow>(
      await request(h.server).post('/api/admin/users').set(auth(rootToken))
        .send({ email: 'admin@koda.test', name: 'admin', password: TEST_PASSWORD, role: 'ADMIN' })
        .expect(201),
    );

    expect(await h.boundRoles('USER', created.id)).toEqual([{ roleKey: 'member', projectId: null }]);
  });

  it('AC-13: a create that sends { role: ADMIN } grants only the member binding', async () => {
    const created = data<UserRow>(
      await request(h.server).post('/api/admin/users').set(auth(rootToken))
        .send({ email: 'admin2@koda.test', name: 'admin2', password: TEST_PASSWORD, role: 'ADMIN' })
        .expect(201),
    );

    expect(await h.boundRoles('USER', created.id)).toEqual([{ roleKey: 'member', projectId: null }]);
  });

  /**
   * Permissions P1l (US-005) supersedes US-004's AC-14 and AC-15: demoting is the `DELETE` of the
   * global admin binding, so a patch that still sends `role` changes neither the binding nor the row.
   */
  it('AC-14: a role patch leaves the admin binding in place', async () => {
    const target = await createUser('demoted@koda.test', true);
    const bindingId = await adminBindingId(target.id);

    await patchUser(target.id, { role: 'MEMBER' }).expect(200);

    expect(await h.boundRoles('USER', target.id)).toHaveLength(2);
    expect(await h.boundRoles('USER', target.id)).toContainEqual({ roleKey: 'admin', projectId: null });
    expect(await h.db.roleBinding.count({ where: { id: bindingId } })).toBe(1);
  });

  it('AC-15: a role patch keeps the global admin binding', async () => {
    const target = await createUser('demoted2@koda.test', true);
    await patchUser(target.id, { role: 'MEMBER' }).expect(200);

    expect(await h.boundRoles('USER', target.id)).toContainEqual({ roleKey: 'admin', projectId: null });
  });

  /**
   * Permissions P1l (US-005): `disabled` is the only patch field the last-admin guard still applies
   * to, so AC-16 and AC-17 exercise the refusal through a disable.
   */
  it('AC-16: disabling the last active admin answers the existing last-admin error', async () => {
    const target = await createUser('last-admin@koda.test', true);
    await withOnlyActiveAdmin(target.id, async (token) => {
      // The premise is exactly one enabled bound admin.
      expect(await activeAdminCount()).toBe(1);

      const res = await request(h.server).patch(`/api/admin/users/${target.id}`).set(auth(token)).send({ disabled: true });

      expect(res.status).toBe(409);
      // `ConflictAppException({}, 'users.lastAdmin')` translates `users.lastAdmin.409`.
      expect(String(res.body.message)).toContain('At least one active administrator must remain');
    });
  });

  it("AC-17: the refused disable leaves the target's admin binding in place", async () => {
    const target = await createUser('last-admin2@koda.test', true);
    await withOnlyActiveAdmin(target.id, async (token) => {
      expect(await activeAdminCount()).toBe(1);

      await request(h.server).patch(`/api/admin/users/${target.id}`).set(auth(token)).send({ disabled: true }).expect(409);
    });

    expect(await h.boundRoles('USER', target.id)).toContainEqual({ roleKey: 'admin', projectId: null });
  });

  it('AC-18: POST /agents gives the new agent a projectId-null agent binding', async () => {
    const res = await request(h.server)
      .post('/api/agents')
      .set(auth(rootToken))
      .send({ name: 'Bound Agent', slug: 'bound-agent', capabilities: ['typescript'] });

    expect(res.status).toBe(201);
    const created = data<{ agent: { id: string } }>(res);

    expect(await h.boundRoles('AGENT', created.agent.id)).toEqual([{ roleKey: 'agent', projectId: null }]);
  });

  it('AC-19: DELETE /agents/:slug leaves no AGENT binding for that agent', async () => {
    const res = await request(h.server)
      .post('/api/agents')
      .set(auth(rootToken))
      .send({ name: 'Doomed Agent', slug: 'doomed-agent' });
    expect(res.status).toBe(201);
    const agentId = data<{ agent: { id: string } }>(res).agent.id;

    await request(h.server).delete('/api/agents/doomed-agent').set(auth(rootToken)).expect(200);

    expect(await h.db.roleBinding.count({ where: { principalType: 'AGENT', principalId: agentId } })).toBe(0);
  });

  /** Permissions P1l (US-005): demoting is the DELETE of the admin binding, and it revokes the token. */
  it('AC-20: deleting the admin binding revokes the earlier access token', async () => {
    const target = await createUser('token-user@koda.test', true);
    const token = await loginToken(h.server, 'token-user@koda.test');
    await request(h.server).get('/api/auth/me').set(auth(token)).expect(200);

    await request(h.server).delete(`/api/role-bindings/${await adminBindingId(target.id)}`)
      .set(auth(rootToken)).expect(204);

    await request(h.server).get('/api/auth/me').set(auth(token)).expect(401);
  });

  it('AC-21: removing a user\'s admin binding leaves only the owner binding', async () => {
    const target = await createUser('owner-admin@koda.test', true);
    await grantOwner(target.id);

    await request(h.server).delete(`/api/role-bindings/${await adminBindingId(target.id)}`)
      .set(auth(rootToken)).expect(204);

    // Of the two global admin roles, only `owner` survives; the baseline `member` is untouched.
    const bindings = await h.boundRoles('USER', target.id);
    expect(bindings).toHaveLength(2);
    expect(bindings).toContainEqual({ roleKey: 'owner', projectId: null });
    expect(bindings).toContainEqual({ roleKey: 'member', projectId: null });
  });

  it('AC-22: an Owner keeps its owner binding after the admin binding is removed', async () => {
    const target = await createUser('owner-admin2@koda.test', true);
    await grantOwner(target.id);

    await request(h.server).delete(`/api/role-bindings/${await adminBindingId(target.id)}`)
      .set(auth(rootToken)).expect(204);

    expect(await h.boundRoles('USER', target.id)).toContainEqual({ roleKey: 'owner', projectId: null });
  });

  it('AC-23: a role patch never grants bindings to an unbound user', async () => {
    const legacy = await h.db.user.create({
      data: { email: 'legacy-admin@koda.test', name: 'Legacy', passwordHash: 'not-a-real-hash' },
    });
    expect(await h.boundRoles('USER', legacy.id)).toEqual([]);

    await patchUser(legacy.id, { role: 'MEMBER' }).expect(200);

    expect(await h.boundRoles('USER', legacy.id)).toEqual([]);
  });

  it('AC-26: disabling a user without a role change still revokes their session', async () => {
    const target = await createUser('disabled-user@koda.test');
    const token = await loginToken(h.server, 'disabled-user@koda.test');
    await request(h.server).get('/api/auth/me').set(auth(token)).expect(200);

    await patchUser(target.id, { disabled: true }).expect(200);

    await request(h.server).get('/api/auth/me').set(auth(token)).expect(401);
  });

  it('B4: a failed baseline binding rolls the admin-created user back', async () => {
    // No `member` role row: the baseline binding cannot be written, so the user row must not survive.
    // The role's bindings are removed first (the relation is RESTRICT) and put back afterwards.
    const member = await h.db.role.findUniqueOrThrow({ where: { key: 'member' } });
    const memberBindings = await h.db.roleBinding.findMany({ where: { roleId: member.id } });
    await h.db.roleBinding.deleteMany({ where: { roleId: member.id } });
    await h.db.role.delete({ where: { key: 'member' } });

    try {
      const res = await request(h.server)
        .post('/api/admin/users')
        .set(auth(rootToken))
        .send({
          email: 'no-baseline@koda.test',
          name: 'No baseline',
          password: TEST_PASSWORD,
        });

      expect(res.status).toBe(404);
      expect(await h.db.user.count({ where: { email: 'no-baseline@koda.test' } })).toBe(0);
    } finally {
      await h.db.role.create({
        data: {
          id: member.id,
          key: member.key,
          name: member.name,
          description: member.description,
          scope: member.scope,
          system: member.system,
          locked: member.locked,
          permissions: member.permissions as Prisma.InputJsonValue,
        },
      });
      await h.db.roleBinding.createMany({ data: memberBindings });
    }

    // With the baseline writable again the same request succeeds, and nothing of the failed attempt
    // is left behind.
    const retry = await createUser('no-baseline@koda.test');

    expect(await h.boundRoles('USER', retry.id)).toEqual([{ roleKey: 'member', projectId: null }]);
  });
});

/**
 * Permissions P1a US-005 — the roles API over real HTTP + Postgres (AC-1 .. AC-27).
 *
 * One booted application for the whole file: the first registration is the installation's Owner
 * (US-004's owner binding, no test-only bypass), and the admin and member actors are created through
 * `POST /admin/users`, so every 200/403 below is decided by real bindings.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/roles-api.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import type { KodaPrincipal } from '../../../src/auth/principal/koda-principal.types';
import { PermissionService } from '../../../src/permissions/permission.service';
import { SYSTEM_ROLES } from '../../../src/permissions/system-roles';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const OWNER_EMAIL = 'owner@koda.test';
const ADMIN_EMAIL = 'admin@koda.test';
const MEMBER_EMAIL = 'member@koda.test';
/** B1's two restricted grantors: they hold `role.manage` and `role.binding.global`, nothing else global. */
const RESTRICTED_GRANTER_EMAIL = 'restricted-granter@koda.test';
const RESTRICTED_GRANTER_2_EMAIL = 'restricted-granter-2@koda.test';
/** Booting `AppModule` runs the system-role seeder, so the first hook needs a generous budget. */
const BOOT_TIMEOUT_MS = 30_000;

/** The `GlobalExceptionsFilter` envelope codes these routes answer with. */
const CODE = { validation: -2, forbidden: 40003, notFound: 404, conflict: 409 } as const;

/** `permissions.json` as the i18n loader reads it: the expected sentence of every refusal. */
const TRANSLATIONS = JSON.parse(
  readFileSync(join(__dirname, '../../../src/i18n/en/permissions.json'), 'utf8'),
) as Record<string, unknown>;

interface RoleBody {
  id: string;
  key: string;
  name: string;
  description: string;
  scope: string;
  system: boolean;
  locked: boolean;
  permissions: string[];
}

/** The sentence at `permissions.<path>.<code>`, with its `{arg}` placeholders filled in. */
function sentence(path: string, code: number, args: Record<string, string> = {}): string {
  const key = path === '' ? `permissions.${code}` : `permissions.${path}.${code}`;
  const node = key.split('.').reduce<unknown>(
    (current, segment) =>
      typeof current === 'object' && current !== null
        ? (current as Record<string, unknown>)[segment]
        : undefined,
    { permissions: TRANSLATIONS },
  );
  if (typeof node !== 'string') throw new Error(`${key} is not declared in src/i18n/en/permissions.json`);
  return node.replace(/\{(\w+)\}/g, (placeholder, name: string) => args[name] ?? placeholder);
}

describeIntegration('roles API (US-005)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let ownerToken: string;
  let adminToken: string;
  let memberToken: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const getRoles = (token: string) => request(server).get('/api/roles').set(auth(token));
  const postRole = (token: string, body: Record<string, unknown>) =>
    request(server).post('/api/roles').set(auth(token)).send(body);
  const patchRole = (token: string, id: string, body: Record<string, unknown>) =>
    request(server).patch(`/api/roles/${id}`).set(auth(token)).send(body);
  const deleteRole = (token: string, id: string) =>
    request(server).delete(`/api/roles/${id}`).set(auth(token));

  /** A role row by key, or null — the stored-state assertions read the database, not the API. */
  const storedRole = (key: string) =>
    db.role.findUnique({ where: { key }, include: { _count: { select: { bindings: true } } } });

  const storedRoleId = async (key: string): Promise<string> => {
    const role = await storedRole(key);
    expect(role).not.toBeNull();
    return (role as NonNullable<typeof role>).id;
  };

  const userByEmail = (email: string) => db.user.findFirstOrThrow({ where: { email } });

  /** The refusal contract of one error: status, envelope code and the exact translated sentence. */
  const expectRefusal = (
    res: request.Response,
    expected: { status: number; code: number; key: string; args?: Record<string, string> },
  ): void => {
    expect(res.status).toBe(expected.status);
    expect(res.body.ret).toBe(expected.code);
    expect(res.body.message).toBe(sentence(expected.key, expected.code, expected.args));
  };

  /** Creates a user through the admin route, then logs in: the token carries no bypass of its own. */
  const createUser = async (email: string, role: 'MEMBER' | 'ADMIN'): Promise<string> => {
    await request(server)
      .post('/api/admin/users')
      .set(auth(ownerToken))
      .send({ email, name: email.split('@')[0], password: TEST_PASSWORD, role })
      .expect(201);
    return loginToken(server, email);
  };

  /** The `PermissionService` the routes use, so `can` is evaluated exactly as production does. */
  const permissions = (): PermissionService => app.get(PermissionService);

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    server = app.getHttpServer();
    db = app.get<PrismaService<PrismaClient>>(PrismaService).client as PrismaClient;

    const registered = await request(server)
      .post('/api/auth/register')
      .send({ email: OWNER_EMAIL, name: 'Owner', password: TEST_PASSWORD })
      .expect(201);
    ownerToken = data<{ accessToken: string }>(registered).accessToken;

    adminToken = await createUser(ADMIN_EMAIL, 'ADMIN');
    memberToken = await createUser(MEMBER_EMAIL, 'MEMBER');
  }, BOOT_TIMEOUT_MS);

  beforeEach(() => {
    resetThrottle(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('AC-1: GET /roles by a global admin returns the eleven system roles with every field', async () => {
    const res = await getRoles(adminToken);

    expect(res.status).toBe(200);
    const roles = data<RoleBody[]>(res);
    const system = roles.filter((role) => role.system);
    expect(system.map((role) => role.key).sort()).toEqual(SYSTEM_ROLES.map((role) => role.key).sort());
    expect(system).toHaveLength(11);
    for (const role of system) {
      expect(role).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          key: expect.any(String),
          name: expect.any(String),
          scope: expect.stringMatching(/^(GLOBAL|PROJECT)$/),
          system: true,
          locked: expect.any(Boolean),
          permissions: expect.any(Array),
        }),
      );
    }
  });

  it('AC-2: GET /roles by a user whose only binding is member answers 403', async () => {
    const res = await getRoles(memberToken);

    expectRefusal(res, { status: 403, code: CODE.forbidden, key: '' });
  });

  it('AC-3: POST /roles by the owner creates a PROJECT role with system false', async () => {
    const res = await postRole(ownerToken, {
      key: 'qa',
      name: 'QA',
      scope: 'PROJECT',
      permissions: ['ticket.read', 'comment.create'],
    });

    expect(res.status).toBe(201);
    expect(data<RoleBody>(res)).toEqual(
      expect.objectContaining({
        key: 'qa',
        name: 'QA',
        scope: 'PROJECT',
        system: false,
        permissions: ['ticket.read', 'comment.create'],
      }),
    );
  });

  it('AC-4: an entry outside the catalog answers 400 permissions.unknownEntry', async () => {
    const res = await postRole(ownerToken, {
      key: 'unknown-entry',
      name: 'Unknown entry',
      scope: 'PROJECT',
      permissions: ['no.such.key'],
    });

    expectRefusal(res, {
      status: 400,
      code: CODE.validation,
      key: 'unknownEntry',
      args: { entry: 'no.such.key' },
    });
  });

  it('AC-5: a global key inside a PROJECT role answers 400 permissions.scopeMismatch', async () => {
    const res = await postRole(ownerToken, {
      key: 'scope-mismatch',
      name: 'Scope mismatch',
      scope: 'PROJECT',
      permissions: ['user.create'],
    });

    expectRefusal(res, {
      status: 400,
      code: CODE.validation,
      key: 'scopeMismatch',
      args: { entry: 'user.create' },
    });
  });

  it('POST /roles answers the standard 400 validation response for a malformed key or scope', async () => {
    const badKey = await postRole(ownerToken, {
      key: 'Not A Key',
      name: 'Bad key',
      scope: 'PROJECT',
      permissions: [],
    });
    expect(badKey.status).toBe(400);
    expect(badKey.body.ret).toBe(CODE.validation);

    const badScope = await postRole(ownerToken, {
      key: 'bad-scope',
      name: 'Bad scope',
      scope: 'TENANT',
      permissions: [],
    });
    expect(badScope.status).toBe(400);
    expect(badScope.body.ret).toBe(CODE.validation);

    expect(await storedRole('bad-scope')).toBeNull();
  });

  it('AC-6: a validation refusal leaves no role with the requested key', async () => {
    await postRole(ownerToken, {
      key: 'never-stored',
      name: 'Never stored',
      scope: 'PROJECT',
      permissions: ['no.such.key'],
    }).expect(400);
    await postRole(ownerToken, {
      key: 'never-stored-either',
      name: 'Never stored either',
      scope: 'PROJECT',
      permissions: ['user.create'],
    }).expect(400);

    expect(await storedRole('never-stored')).toBeNull();
    expect(await storedRole('never-stored-either')).toBeNull();
  });

  it('AC-7: POST /roles with an existing key answers 409 permissions.roleKeyTaken', async () => {
    const res = await postRole(ownerToken, {
      key: 'developer',
      name: 'Developer again',
      scope: 'PROJECT',
      permissions: ['ticket.read'],
    });

    expectRefusal(res, { status: 409, code: CODE.conflict, key: 'roleKeyTaken' });
  });

  it('AC-8: an admin escalating to role.binding.owner answers 403 permissions.escalation', async () => {
    const res = await postRole(adminToken, {
      key: 'owner-clone',
      name: 'Owner clone',
      scope: 'GLOBAL',
      permissions: ['role.binding.owner'],
    });

    expectRefusal(res, { status: 403, code: CODE.forbidden, key: 'escalation' });
  });

  it('AC-9: an admin writing * into the member role answers 403 permissions.escalation', async () => {
    const member = await storedRoleId('member');

    const res = await patchRole(adminToken, member, { permissions: ['*'] });

    expectRefusal(res, { status: 403, code: CODE.forbidden, key: 'escalation' });
  });

  it('AC-10: the refused escalation leaves the member role permissions unchanged', async () => {
    const before = (await storedRole('member'))?.permissions;
    const member = await storedRoleId('member');
    await patchRole(adminToken, member, { permissions: ['*'] }).expect(403);

    expect((await storedRole('member'))?.permissions).toEqual(before);
  });

  it('AC-11: an admin may narrow the developer role to ticket.read', async () => {
    const developer = await storedRoleId('developer');

    const res = await patchRole(adminToken, developer, { permissions: ['ticket.read'] });

    expect(res.status).toBe(200);
    expect(data<RoleBody>(res)).toEqual(
      expect.objectContaining({ key: 'developer', scope: 'PROJECT', permissions: ['ticket.read'] }),
    );
    expect((await storedRole('developer'))?.permissions).toEqual(['ticket.read']);
  });

  it('AC-12: an unknown entry on PATCH answers 400 permissions.unknownEntry', async () => {
    const developer = await storedRoleId('developer');

    const res = await patchRole(adminToken, developer, { permissions: ['bad.key'] });

    expectRefusal(res, {
      status: 400,
      code: CODE.validation,
      key: 'unknownEntry',
      args: { entry: 'bad.key' },
    });
  });

  it.each(['name', 'description', 'permissions'])('PATCH rejects explicit null %s without changing the role', async (field) => {
    const created = await postRole(ownerToken, {
      key: `null-${field}`,
      name: 'Null validation',
      scope: 'PROJECT',
      permissions: ['ticket.read'],
    }).expect(201);
    const roleId = data<RoleBody>(created).id;
    const before = await storedRole(`null-${field}`);

    const res = await patchRole(ownerToken, roleId, { [field]: null });

    expect(res.status).toBe(400);
    expect(res.body.ret).toBe(CODE.validation);
    expect(await storedRole(`null-${field}`)).toEqual(before);
  });

  it('PATCH permits omitted fields and empty permissions', async () => {
    const created = await postRole(ownerToken, {
      key: 'optional-fields',
      name: 'Optional fields',
      description: 'Keep me',
      scope: 'PROJECT',
      permissions: ['ticket.read'],
    }).expect(201);
    const roleId = data<RoleBody>(created).id;

    await patchRole(ownerToken, roleId, {}).expect(200);
    const res = await patchRole(ownerToken, roleId, { permissions: [] }).expect(200);

    expect(data<RoleBody>(res)).toEqual(expect.objectContaining({
      name: 'Optional fields', description: 'Keep me', permissions: [],
    }));
  });

  it('AC-13: a global key on a PROJECT role answers 400 permissions.scopeMismatch', async () => {
    const developer = await storedRoleId('developer');

    const res = await patchRole(adminToken, developer, { permissions: ['user.create'] });

    expectRefusal(res, {
      status: 400,
      code: CODE.validation,
      key: 'scopeMismatch',
      args: { entry: 'user.create' },
    });
  });

  it('AC-14: renaming a system role answers 400 permissions.systemRole', async () => {
    const developer = await storedRoleId('developer');

    const res = await patchRole(adminToken, developer, { name: 'Dev' });

    expectRefusal(res, { status: 400, code: CODE.validation, key: 'systemRole' });
    expect((await storedRole('developer'))?.name).toBe('Developer');
  });

  it('AC-15: editing the locked owner role answers 403 permissions.ownerLocked', async () => {
    const owner = await storedRoleId('owner');

    const res = await patchRole(ownerToken, owner, { description: 'Changed' });

    expectRefusal(res, { status: 403, code: CODE.forbidden, key: 'ownerLocked' });
    expect((await storedRole('owner'))?.description).toBe('');
  });

  it('AC-16: deleting the locked owner role answers 403 permissions.ownerLocked', async () => {
    const owner = await storedRoleId('owner');

    const res = await deleteRole(ownerToken, owner);

    expectRefusal(res, { status: 403, code: CODE.forbidden, key: 'ownerLocked' });
    expect(await storedRole('owner')).not.toBeNull();
  });

  it('AC-17: deleting the unlocked system role viewer answers 403 permissions.systemRole', async () => {
    const viewer = await storedRoleId('viewer');

    const res = await deleteRole(ownerToken, viewer);

    expectRefusal(res, { status: 403, code: CODE.forbidden, key: 'systemRole' });
    expect(await storedRole('viewer')).not.toBeNull();
  });

  it('AC-18: deleting a role a binding references answers 409 permissions.roleInUse', async () => {
    const created = await postRole(ownerToken, {
      key: 'qa-bound',
      name: 'QA bound',
      scope: 'PROJECT',
      permissions: ['ticket.read'],
    }).expect(201);
    const roleId = data<RoleBody>(created).id;
    const member = await userByEmail(MEMBER_EMAIL);
    await db.roleBinding.create({
      data: {
        principalType: 'USER',
        principalId: member.id,
        roleId,
        projectId: null,
        grantedByType: 'SYSTEM',
        grantedById: 'test',
      },
    });

    const res = await deleteRole(ownerToken, roleId);

    expectRefusal(res, { status: 409, code: CODE.conflict, key: 'roleInUse' });
    expect(await storedRole('qa-bound')).not.toBeNull();
  });

  it('AC-19: after its binding is removed, deleting qa answers 204', async () => {
    const created = await postRole(ownerToken, {
      key: 'qa-deletable',
      name: 'QA deletable',
      scope: 'PROJECT',
      permissions: ['ticket.read'],
    }).expect(201);
    const roleId = data<RoleBody>(created).id;
    const member = await userByEmail(MEMBER_EMAIL);
    const binding = await db.roleBinding.create({
      data: {
        principalType: 'USER',
        principalId: member.id,
        roleId,
        projectId: null,
        grantedByType: 'SYSTEM',
        grantedById: 'test',
      },
    });
    await deleteRole(ownerToken, roleId).expect(409);
    await db.roleBinding.delete({ where: { id: binding.id } });

    await deleteRole(ownerToken, roleId).expect(204);
  });

  it('AC-20: a deleted role is absent from the database and from GET /roles', async () => {
    const created = await postRole(ownerToken, {
      key: 'qa-gone',
      name: 'QA gone',
      scope: 'PROJECT',
      permissions: ['ticket.read'],
    }).expect(201);
    const roleId = data<RoleBody>(created).id;

    await deleteRole(ownerToken, roleId).expect(204);

    expect(await storedRole('qa-gone')).toBeNull();
    const roles = data<RoleBody[]>(await getRoles(ownerToken).expect(200));
    expect(roles.map((role) => role.key)).not.toContain('qa-gone');
  });

  it('AC-21: editing a PROJECT role bound in a project changes the next can evaluation', async () => {
    const project = await db.project.create({ data: { slug: 'alpha', name: 'Alpha', key: 'ALP' } });
    const user = await userByEmail(MEMBER_EMAIL);
    const principal: KodaPrincipal = {
      actorType: 'user',
      id: user.id,
      role: user.role as 'MEMBER' | 'ADMIN',
      email: user.email,
    };
    const created = await postRole(ownerToken, {
      key: 'qa-live',
      name: 'QA live',
      scope: 'PROJECT',
      permissions: ['ticket.read'],
    }).expect(201);
    const roleId = data<RoleBody>(created).id;
    await db.roleBinding.create({
      data: {
        principalType: 'USER',
        principalId: user.id,
        roleId,
        projectId: project.id,
        grantedByType: 'SYSTEM',
        grantedById: 'test',
      },
    });

    const before = await permissions().can(principal, 'ticket.create', { projectId: project.id });
    expect(before.allowed).toBe(false);

    await patchRole(ownerToken, roleId, {
      permissions: ['ticket.read', 'ticket.create'],
    }).expect(200);

    const after = await permissions().can(principal, 'ticket.create', { projectId: project.id });
    expect(after.allowed).toBe(true);
  });

  it('AC-22: the exported OpenAPI document lists all four roles operations', () => {
    const nestApp = app.getNestApp<INestApplication>();
    const config = new DocumentBuilder()
      .setTitle('Koda API')
      .setDescription('Dev ticket tracker API')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(nestApp, config);

    // Exact paths: `/api/projects/{slug}/roles` (US-003's project roles route) also ends in `/roles`,
    // and a suffix match would compare it against the global role writes.
    const operation = (path: string, method: string) => {
      const match = Object.entries(document.paths).find(([candidate]) => candidate === path);
      expect(match, `no path ${path}`).toBeDefined();
      const [, item] = match as [string, Record<string, unknown>];
      const op = item[method] as { tags?: string[]; summary?: string; responses?: Record<string, unknown> } | undefined;
      expect(op, `no ${method.toUpperCase()} ${path}`).toBeDefined();
      const defined = op as NonNullable<typeof op>;
      expect(defined.tags?.length ?? 0).toBeGreaterThan(0);
      expect(defined.summary).toBeTruthy();
      expect(Object.keys(defined.responses ?? {}).length).toBeGreaterThan(0);
    };

    operation('/api/roles', 'get');
    operation('/api/roles', 'post');
    operation('/api/roles/{id}', 'patch');
    operation('/api/roles/{id}', 'delete');
  });

  it('AC-23: the first registration can read roles through its owner binding', async () => {
    const res = await getRoles(ownerToken);

    expect(res.status).toBe(200);
    expect(Array.isArray(data<RoleBody[]>(res))).toBe(true);
  });

  it('AC-24: concurrent creates of the same unused key leave one role and one roleKeyTaken', async () => {
    const body = {
      key: 'qa-raced',
      name: 'QA raced',
      scope: 'PROJECT',
      permissions: ['ticket.read'],
    };

    const results = await Promise.all([postRole(ownerToken, body), postRole(ownerToken, body)]);
    const statuses = results.map((res) => res.status).sort();

    expect(statuses).toEqual([201, 409]);
    const loser = results.find((res) => res.status === 409) as request.Response;
    expectRefusal(loser, { status: 409, code: CODE.conflict, key: 'roleKeyTaken' });
    expect(await db.role.count({ where: { key: 'qa-raced' } })).toBe(1);
  });

  it('AC-25: a refused escalation stores no role', async () => {
    await postRole(adminToken, {
      key: 'escalated',
      name: 'Escalated',
      scope: 'GLOBAL',
      permissions: ['role.binding.owner'],
    }).expect(403);

    expect(await storedRole('escalated')).toBeNull();
  });

  it('AC-26: a refused PATCH leaves the stored role unchanged', async () => {
    const projectRole = await postRole(ownerToken, {
      key: 'qa-stable',
      name: 'QA stable',
      scope: 'PROJECT',
      permissions: ['ticket.read'],
    }).expect(201);
    const projectRoleId = data<RoleBody>(projectRole).id;
    const before = await storedRole('qa-stable');

    await patchRole(adminToken, projectRoleId, { permissions: ['bad.key'] }).expect(400);

    expect(await storedRole('qa-stable')).toEqual(before);

    // The escalation case needs a GLOBAL role: `role.binding.owner` is a global key, which a PROJECT
    // role cannot hold at all (that is the scopeMismatch case, not escalation).
    const globalRole = await postRole(ownerToken, {
      key: 'global-stable',
      name: 'Global stable',
      scope: 'GLOBAL',
      permissions: ['role.read'],
    }).expect(201);
    const globalRoleId = data<RoleBody>(globalRole).id;
    const globalBefore = await storedRole('global-stable');

    await patchRole(adminToken, globalRoleId, { permissions: ['role.binding.owner'] }).expect(403);

    expect(await storedRole('global-stable')).toEqual(globalBefore);
  });

  it('AC-27: POST /roles without role.manage answers the bare permissions refusal', async () => {
    const res = await postRole(memberToken, {
      key: 'member-role',
      name: 'Member role',
      scope: 'PROJECT',
      permissions: ['ticket.read'],
    });

    expectRefusal(res, { status: 403, code: CODE.forbidden, key: '' });
    expect(await storedRole('member-role')).toBeNull();
  });

  /**
   * B1: the admin role is unlocked, so a caller holding `role.manage` may edit it — but only within its
   * own authority. `admin` confers every global key except `role.binding.owner` **plus** every project
   * key and the legacy `User.role = 'ADMIN'` status, none of which are in its editable entry list. The
   * escalation check therefore compares the whole conferred set, not just the entries it is handed.
   */
  const restrictedRoleGranter = async (email: string): Promise<string> => {
    const token = await createUser(email, 'MEMBER');
    const granter = await userByEmail(email);
    const role =
      (await db.role.findUnique({ where: { key: 'restricted-role-granter' } })) ??
      (await db.role.create({
        data: {
          key: 'restricted-role-granter',
          name: 'Restricted role granter',
          description: '',
          scope: 'GLOBAL',
          system: false,
          locked: false,
          permissions: ['role.manage', 'role.binding.global'],
        },
      }));
    await db.roleBinding.create({
      data: {
        principalType: 'USER',
        principalId: granter.id,
        roleId: role.id,
        projectId: null,
        grantedByType: 'SYSTEM',
        grantedById: 'test',
      },
    });
    return token;
  };

  it('B1: a role manager without admin authority cannot empty the admin role', async () => {
    const token = await restrictedRoleGranter(RESTRICTED_GRANTER_EMAIL);
    const admin = await storedRoleId('admin');
    const before = (await storedRole('admin'))?.permissions;

    const res = await patchRole(token, admin, { permissions: [] });

    expectRefusal(res, { status: 403, code: CODE.forbidden, key: 'escalation' });
    expect((await storedRole('admin'))?.permissions).toEqual(before);
  });

  it("B1: the same caller is refused when it strips the admin role's owner-key exclusion", async () => {
    const token = await restrictedRoleGranter(RESTRICTED_GRANTER_2_EMAIL);
    const admin = await storedRoleId('admin');

    const res = await patchRole(token, admin, { permissions: ['*'] });

    expectRefusal(res, { status: 403, code: CODE.forbidden, key: 'escalation' });
  });
});

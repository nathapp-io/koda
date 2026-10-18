/**
 * Permissions P1a US-006 — the role-bindings API over real HTTP + Postgres (AC-1 .. AC-29).
 *
 * One booted application for the whole file: the first registration is the installation's Owner
 * (US-004's owner binding, no test-only bypass). The admin and the acting project members are created
 * through `POST /admin/users`, so every 200/400/403/404 below is decided by real bindings and by the
 * real `RoleAdminService` -> `MembershipService` path. Fixture rows that no test mutates (targets,
 * custom roles, agents) are seeded straight into the database in `beforeAll`, so each `it` writes
 * what it reads.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/role-bindings-api.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import type { KodaPrincipal } from '../../../src/auth/principal/koda-principal.types';
import { PermissionService } from '../../../src/permissions/permission.service';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const OWNER_EMAIL = 'owner@koda.test';
const ADMIN_EMAIL = 'admin@koda.test';
const PA_ALPHA_EMAIL = 'pa-alpha@koda.test';
const PA_BETA_EMAIL = 'pa-beta@koda.test';
const ESCALATOR_EMAIL = 'escalator@koda.test';
const BINDING_MGR_EMAIL = 'binding-mgr@koda.test';
/** Booting `AppModule` runs the system-role seeder, so the first hook needs a generous budget. */
const BOOT_TIMEOUT_MS = 30_000;

/** The `GlobalExceptionsFilter` envelope codes these routes answer with. */
const CODE = { validation: -2, forbidden: 40003 } as const;

/** `permissions.json` as the i18n loader reads it: the expected sentence of every refusal. */
const TRANSLATIONS = JSON.parse(
  readFileSync(join(__dirname, '../../../src/i18n/en/permissions.json'), 'utf8'),
) as Record<string, unknown>;

interface BindingBody {
  id: string;
  principalType: string;
  principalId: string;
  roleId: string;
  roleKey: string;
  projectId: string | null;
  grantedByType: string;
  grantedById: string;
  createdAt: string;
}

interface PageBody {
  total: number;
  current: number;
  size: number;
  hasNext: boolean;
  hasPrev: boolean;
  records: BindingBody[];
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

/** `projects.404`: the sentence both project-lookup refusals must carry. */
const PROJECT_NOT_FOUND = (
  JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en/projects.json'), 'utf8')) as Record<
    string,
    string
  >
)['404'];

describeIntegration('role bindings API (US-006)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;

  let ownerToken: string;
  let ownerId: string;
  let adminToken: string;
  let paAlphaToken: string;
  let paAlphaId: string;
  let paBetaToken: string;
  let escalatorToken: string;
  let bindingMgrToken: string;

  let alphaId: string;
  let betaId: string;
  let goneProjectId: string;

  let agentAId: string;
  let agentBId: string;
  let agentCId: string;

  let ownerOnlyTargetId: string;
  let adminTargetAId: string;
  let adminTargetBId: string;
  let adminTargetCId: string;
  let ownerBId: string;
  let ownerCId: string;
  let devTargetId: string;
  let devTarget2Id: string;
  let grantTargetId: string;
  let raceAId: string;
  let raceBId: string;
  let ownerBindingId: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const getBindings = (token: string, query: Record<string, string> = {}) =>
    request(server).get('/api/role-bindings').query(query).set(auth(token));
  const postBinding = (token: string, body: Record<string, unknown>) =>
    request(server).post('/api/role-bindings').set(auth(token)).send(body);
  const deleteBinding = (token: string, id: string) =>
    request(server).delete(`/api/role-bindings/${id}`).set(auth(token));

  const roleId = async (key: string): Promise<string> =>
    (await db.role.findUniqueOrThrow({ where: { key } })).id;

  const bind = async (
    principalType: 'USER' | 'AGENT',
    principalId: string,
    roleKey: string,
    projectId: string | null = null,
  ) =>
    db.roleBinding.create({
      data: {
        principalType,
        principalId,
        roleId: await roleId(roleKey),
        projectId,
        grantedByType: 'SYSTEM',
        grantedById: 'test',
      },
    });

  const newUser = (email: string, role: 'MEMBER' | 'ADMIN' = 'MEMBER') =>
    db.user.create({
      data: { email, name: email.split('@')[0], passwordHash: 'not-a-real-hash', role },
    });

  const newAgent = (slug: string) =>
    db.agent.create({ data: { name: slug, slug, apiKeyHash: `hash-${slug}` } });

  /** Exactly one `owner` binding for the user, replacing any earlier one this run left behind. */
  const bindOwner = async (userId: string) => {
    await db.roleBinding.deleteMany({ where: { principalId: userId, role: { key: 'owner' } } });
    return bind('USER', userId, 'owner');
  };

  const createRole = (key: string, scope: 'GLOBAL' | 'PROJECT', permissions: string[]) =>
    db.role.create({
      data: { key, name: key, description: '', scope, system: false, locked: false, permissions },
    });

  const userRow = (id: string) => db.user.findUniqueOrThrow({ where: { id } });

  const principalOf = (user: { id: string; role: string; email: string }): KodaPrincipal => ({
    actorType: 'user',
    id: user.id,
    role: user.role as 'MEMBER' | 'ADMIN',
    email: user.email,
  });

  const permissions = (): PermissionService => app.get(PermissionService);
  const bindingCount = (where: Prisma.RoleBindingWhereInput) => db.roleBinding.count({ where });

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
  const createUserWithToken = async (email: string, role: 'MEMBER' | 'ADMIN'): Promise<string> => {
    const created = await request(server)
      .post('/api/admin/users')
      .set(auth(ownerToken))
      .send({ email, name: email.split('@')[0], password: TEST_PASSWORD, role })
      .expect(201);
    expect(data<{ id: string }>(created).id).toBeTruthy();
    // Login is throttled to 5/min per instance; this hook performs more logins than that.
    resetThrottle(app);
    return loginToken(server, email);
  };

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
    ownerId = data<{ user: { id: string } }>(registered).user.id;

    adminToken = await createUserWithToken(ADMIN_EMAIL, 'ADMIN');
    paAlphaToken = await createUserWithToken(PA_ALPHA_EMAIL, 'MEMBER');
    paAlphaId = (await db.user.findUniqueOrThrow({ where: { email: PA_ALPHA_EMAIL } })).id;
    paBetaToken = await createUserWithToken(PA_BETA_EMAIL, 'MEMBER');
    escalatorToken = await createUserWithToken(ESCALATOR_EMAIL, 'MEMBER');
    bindingMgrToken = await createUserWithToken(BINDING_MGR_EMAIL, 'MEMBER');

    const alpha = await db.project.create({ data: { name: 'Alpha', slug: 'alpha', key: 'ALP' } });
    const beta = await db.project.create({ data: { name: 'Beta', slug: 'beta', key: 'BET' } });
    alphaId = alpha.id;
    betaId = beta.id;
    goneProjectId = (await db.project.create({
      data: { name: 'Gone', slug: 'gone', key: 'GON', deletedAt: new Date() },
    })).id;

    // The project-admin bindings the acting users hold, plus the two escalation-only custom roles.
    await bind('USER', paAlphaId, 'project-admin', alphaId);
    await bind('USER', (await db.user.findUniqueOrThrow({ where: { email: PA_BETA_EMAIL } })).id, 'project-admin', betaId);
    await createRole('approval-policy-mgr', 'PROJECT', ['approval.policy.manage']);
    await createRole('user-creator', 'GLOBAL', ['user.create']);
    await createRole('bind-viewer', 'GLOBAL', ['role.read', 'role.binding.global']);
    await createRole('binding-manager', 'PROJECT', ['role.binding.manage']);
    const bindingMgr = await db.user.findUniqueOrThrow({ where: { email: BINDING_MGR_EMAIL } });
    await bind('USER', bindingMgr.id, 'binding-manager', alphaId);

    // The escalation caller of AC-21/AC-22: `role.read` + `role.binding.global`, nothing else global.
    const escalator = await db.user.findUniqueOrThrow({ where: { email: ESCALATOR_EMAIL } });
    await bind('USER', escalator.id, 'bind-viewer');

    ownerOnlyTargetId = (await newUser('owner-target@koda.test')).id;
    adminTargetAId = (await newUser('admin-target-a@koda.test', 'ADMIN')).id;
    adminTargetBId = (await newUser('admin-target-b@koda.test', 'ADMIN')).id;
    adminTargetCId = (await newUser('admin-target-c@koda.test', 'ADMIN')).id;
    await bind('USER', adminTargetAId, 'admin');
    await bind('USER', adminTargetBId, 'admin');
    await bind('USER', adminTargetCId, 'admin');
    ownerBId = (await newUser('owner-b@koda.test')).id;
    ownerCId = (await newUser('owner-c@koda.test')).id;
    devTargetId = (await newUser('dev-target@koda.test')).id;
    devTarget2Id = (await newUser('dev-target-2@koda.test')).id;
    grantTargetId = (await newUser('grant-target@koda.test')).id;
    raceAId = (await newUser('race-a@koda.test')).id;
    raceBId = (await newUser('race-b@koda.test')).id;
    await bind('USER', devTargetId, 'developer', alphaId);
    await bind('USER', devTarget2Id, 'developer', alphaId);

    agentAId = (await newAgent('agent-a')).id;
    agentBId = (await newAgent('agent-b')).id;
    agentCId = (await newAgent('agent-c')).id;
    // The global agent baseline a created agent receives, plus a project grant: both must appear in
    // the AC-3 page.
    await bind('AGENT', agentAId, 'agent');
    await bind('AGENT', agentAId, 'developer', alphaId);

    ownerBindingId = (await db.roleBinding.findFirstOrThrow({
      where: { principalId: ownerId, role: { key: 'owner' } },
    })).id;
  }, BOOT_TIMEOUT_MS);

  beforeEach(() => {
    resetThrottle(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('AC-1: a project admin grants developer in alpha and receives 201 with that binding', async () => {
    const developerRoleId = await roleId('developer');

    const res = await postBinding(paAlphaToken, {
      principalType: 'AGENT',
      principalId: agentBId,
      roleKey: 'developer',
      projectId: alphaId,
    });

    expect(res.status).toBe(201);
    const binding = data<BindingBody>(res);
    expect(binding).toEqual(
      expect.objectContaining({
        principalType: 'AGENT',
        principalId: agentBId,
        roleId: developerRoleId,
        roleKey: 'developer',
        projectId: alphaId,
        grantedByType: 'USER',
        grantedById: paAlphaId,
      }),
    );
    expect(await db.roleBinding.findUnique({ where: { id: binding.id } })).toEqual(
      expect.objectContaining({
        principalType: 'AGENT',
        principalId: agentBId,
        roleId: developerRoleId,
        projectId: alphaId,
        grantedByType: 'USER',
        grantedById: paAlphaId,
      }),
    );
  });

  it('AC-2: a project-admin in alpha cannot grant globally and stores nothing', async () => {
    const res = await postBinding(paAlphaToken, {
      principalType: 'AGENT',
      principalId: agentBId,
      roleKey: 'developer',
    });

    expectRefusal(res, { status: 403, code: CODE.forbidden, key: '' });
    expect(await bindingCount({ principalId: agentBId, projectId: null })).toBe(0);
  });

  it('AC-3: the agent binding page answers size 50 with the project grant and the global baseline', async () => {
    const res = await getBindings(adminToken, { principalType: 'AGENT', principalId: agentAId });

    expect(res.status).toBe(200);
    const page = data<PageBody>(res);
    expect(page.size).toBe(50);
    expect(page.total).toBe(2);
    expect(page.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          principalType: 'AGENT',
          principalId: agentAId,
          roleKey: 'developer',
          projectId: alphaId,
        }),
        expect.objectContaining({
          principalType: 'AGENT',
          principalId: agentAId,
          roleKey: 'agent',
          projectId: null,
        }),
      ]),
    );
  });

  it('GET /role-bindings without a filter lists every principal on the default page', async () => {
    const res = await getBindings(adminToken);

    expect(res.status).toBe(200);
    const page = data<PageBody>(res);
    expect(page.current).toBe(1);
    expect(page.size).toBe(50);
    expect(new Set(page.records.map((binding) => binding.principalId)).size).toBeGreaterThan(1);
  });

  it('AC-4: an admin without role.binding.owner cannot grant a global owner binding', async () => {
    const res = await postBinding(adminToken, {
      principalType: 'USER',
      principalId: ownerOnlyTargetId,
      roleKey: 'owner',
    });

    expectRefusal(res, { status: 403, code: CODE.forbidden, key: '' });
  });

  it('AC-5: the refused global owner grant stores no binding for the target', async () => {
    await postBinding(adminToken, {
      principalType: 'USER',
      principalId: ownerOnlyTargetId,
      roleKey: 'owner',
    }).expect(403);

    expect(await bindingCount({ principalId: ownerOnlyTargetId })).toBe(0);
  });

  it('AC-6: a GLOBAL role with a project id answers 400 permissions.scopeMismatch', async () => {
    const res = await postBinding(adminToken, {
      principalType: 'AGENT',
      principalId: agentCId,
      roleKey: 'admin',
      projectId: alphaId,
    });

    expectRefusal(res, {
      status: 400,
      code: CODE.validation,
      key: 'scopeMismatch',
      args: { entry: 'admin' },
    });
    expect(await bindingCount({ principalId: agentCId })).toBe(0);
  });

  it('AC-7: an unknown roleKey answers 404 permissions.roleNotFound', async () => {
    const res = await postBinding(adminToken, {
      principalType: 'AGENT',
      principalId: agentCId,
      roleKey: 'no-such-role',
      projectId: alphaId,
    });

    expectRefusal(res, { status: 404, code: 404, key: 'roleNotFound' });
  });

  it('AC-8: a USER principalId naming no user answers 404 permissions.principalNotFound', async () => {
    const res = await postBinding(adminToken, {
      principalType: 'USER',
      principalId: 'no-such-user',
      roleKey: 'viewer',
      projectId: alphaId,
    });

    expectRefusal(res, { status: 404, code: 404, key: 'principalNotFound' });
  });

  it('AC-9: a project admin grants a project role it holds in full', async () => {
    const res = await postBinding(paAlphaToken, {
      principalType: 'AGENT',
      principalId: agentCId,
      roleKey: 'approval-policy-mgr',
      projectId: alphaId,
    });

    expect(res.status).toBe(201);
    expect(data<BindingBody>(res)).toEqual(
      expect.objectContaining({ roleKey: 'approval-policy-mgr', projectId: alphaId, principalId: agentCId }),
    );
  });

  it('AC-10: a project admin cannot grant a global role it does not hold', async () => {
    const res = await postBinding(paAlphaToken, {
      principalType: 'AGENT',
      principalId: agentCId,
      roleKey: 'user-creator',
    });

    expectRefusal(res, { status: 403, code: CODE.forbidden, key: '' });
    expect(await bindingCount({ principalId: agentCId, projectId: null })).toBe(0);
  });

  it('AC-11: binding a role for the caller itself answers 403 permissions.selfBinding', async () => {
    const res = await postBinding(ownerToken, {
      principalType: 'USER',
      principalId: ownerId,
      roleKey: 'viewer',
      projectId: alphaId,
    });

    expectRefusal(res, { status: 403, code: CODE.forbidden, key: 'selfBinding' });
    expect(await bindingCount({ principalId: ownerId, role: { key: 'viewer' } })).toBe(0);
  });

  it('AC-12: deleting the caller\'s own binding answers 403 permissions.selfBinding', async () => {
    const res = await deleteBinding(ownerToken, ownerBindingId);

    expectRefusal(res, { status: 403, code: CODE.forbidden, key: 'selfBinding' });
    expect(await db.roleBinding.findUnique({ where: { id: ownerBindingId } })).not.toBeNull();
  });

  it('AC-13: an owner deletes another user\'s global admin binding with 204', async () => {
    const binding = await db.roleBinding.findFirstOrThrow({
      where: { principalId: adminTargetAId, projectId: null },
    });

    await deleteBinding(ownerToken, binding.id).expect(204);

    expect(await db.roleBinding.findUnique({ where: { id: binding.id } })).toBeNull();
  });

  it('AC-14: removing the only global admin binding of a target stores User.role MEMBER', async () => {
    const binding = await db.roleBinding.findFirstOrThrow({
      where: { principalId: adminTargetBId, projectId: null },
    });
    expect((await userRow(adminTargetBId)).role).toBe('ADMIN');

    await deleteBinding(ownerToken, binding.id).expect(204);

    expect((await userRow(adminTargetBId)).role).toBe('MEMBER');
    expect(await bindingCount({ principalId: adminTargetBId, role: { key: 'owner' } })).toBe(0);
  });

  it('AC-15: with exactly two owner bindings one owner removes the other\'s binding', async () => {
    const other = await bindOwner(ownerBId);
    expect(await bindingCount({ role: { key: 'owner' } })).toBe(2);

    await deleteBinding(ownerToken, other.id).expect(204);

    expect(await db.roleBinding.findUnique({ where: { id: other.id } })).toBeNull();
    expect(await bindingCount({ role: { key: 'owner' } })).toBe(1);
  });

  it('AC-16: after that removal an admin can no longer delete the remaining owner binding', async () => {
    // Re-run the AC-15 shape so this case owns its precondition: two owners, one removed by an owner.
    const extra = await bindOwner(ownerCId);
    await deleteBinding(ownerToken, extra.id).expect(204);
    expect(await bindingCount({ role: { key: 'owner' } })).toBe(1);

    const remaining = await db.roleBinding.findFirstOrThrow({ where: { role: { key: 'owner' } } });

    const res = await deleteBinding(adminToken, remaining.id);

    expectRefusal(res, { status: 403, code: CODE.forbidden, key: '' });
    expect(await db.roleBinding.findUnique({ where: { id: remaining.id } })).not.toBeNull();
  });

  it('AC-17: a user without role.binding.manage in alpha cannot delete an alpha binding', async () => {
    const binding = await db.roleBinding.findFirstOrThrow({
      where: { principalId: devTargetId, projectId: alphaId },
    });

    const res = await deleteBinding(paBetaToken, binding.id);

    expectRefusal(res, { status: 403, code: CODE.forbidden, key: '' });
    expect(await db.roleBinding.findUnique({ where: { id: binding.id } })).not.toBeNull();
  });

  it('AC-18: the alpha project admin deletes another principal\'s alpha binding with 204', async () => {
    const binding = await db.roleBinding.findFirstOrThrow({
      where: { principalId: devTarget2Id, projectId: alphaId },
    });

    await deleteBinding(paAlphaToken, binding.id).expect(204);

    expect(await db.roleBinding.findUnique({ where: { id: binding.id } })).toBeNull();
  });

  it('AC-19: the granted developer key is allowed on the very next can evaluation', async () => {
    const target = await userRow(grantTargetId);
    const before = await permissions().can(principalOf(target), 'ticket.create', { projectId: alphaId });
    expect(before.allowed).toBe(false);

    await postBinding(ownerToken, {
      principalType: 'USER',
      principalId: grantTargetId,
      roleKey: 'developer',
      projectId: alphaId,
    }).expect(201);

    const after = await permissions().can(principalOf(target), 'ticket.create', { projectId: alphaId });
    expect(after.allowed).toBe(true);
  });

  it('AC-20: the owner role cannot be bound to an agent (400 permissions.principalType)', async () => {
    const res = await postBinding(ownerToken, {
      principalType: 'AGENT',
      principalId: agentCId,
      roleKey: 'owner',
    });

    expectRefusal(res, { status: 400, code: CODE.validation, key: 'principalType' });
    expect(await bindingCount({ principalId: agentCId, role: { key: 'owner' } })).toBe(0);
  });

  it('AC-21: a binding grantor without the role\'s keys answers 403 permissions.escalation', async () => {
    const binding = await db.roleBinding.findFirstOrThrow({
      where: { principalId: adminTargetCId, projectId: null },
    });

    const res = await deleteBinding(escalatorToken, binding.id);

    expectRefusal(res, { status: 403, code: CODE.forbidden, key: 'escalation' });
  });

  it('AC-22: the refused escalation leaves the admin binding unchanged', async () => {
    const binding = await db.roleBinding.findFirstOrThrow({
      where: { principalId: adminTargetCId, projectId: null },
    });
    const before = await db.roleBinding.findUniqueOrThrow({ where: { id: binding.id } });

    await deleteBinding(escalatorToken, binding.id).expect(403);

    expect(await db.roleBinding.findUnique({ where: { id: binding.id } })).toEqual(before);
  });

  it('AC-23: the exported OpenAPI document lists all three role-bindings operations', () => {
    const nestApp = app.getNestApp<INestApplication>();
    const config = new DocumentBuilder()
      .setTitle('Koda API')
      .setDescription('Dev ticket tracker API')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(nestApp, config);

    const operation = (pathSuffix: string, method: string) => {
      const match = Object.entries(document.paths).find(
        ([path]) => path === pathSuffix || path.endsWith(pathSuffix),
      );
      expect(match, `no path ending in ${pathSuffix}`).toBeDefined();
      const [path, item] = match as [string, Record<string, unknown>];
      const op = item[method] as
        | { tags?: string[]; summary?: string; responses?: Record<string, unknown> }
        | undefined;
      expect(op, `no ${method.toUpperCase()} ${path}`).toBeDefined();
      const defined = op as NonNullable<typeof op>;
      expect(defined.tags?.length ?? 0).toBeGreaterThan(0);
      expect(defined.summary).toBeTruthy();
      expect(Object.keys(defined.responses ?? {}).length).toBeGreaterThan(0);
    };

    operation('/role-bindings', 'get');
    operation('/role-bindings', 'post');
    operation('/role-bindings/{id}', 'delete');
  });

  it('AC-24: an unknown projectId answers 404 with the projects prefix', async () => {
    const res = await postBinding(ownerToken, {
      principalType: 'AGENT',
      principalId: agentCId,
      roleKey: 'viewer',
      projectId: 'no-such-project',
    });

    expect(res.status).toBe(404);
    expect(res.body.ret).toBe(404);
    expect(res.body.message).toBe(PROJECT_NOT_FOUND);
    expect(await bindingCount({ principalId: agentCId, projectId: 'no-such-project' })).toBe(0);
  });

  it('AC-25: a soft-deleted projectId answers 404 with the projects prefix', async () => {
    const res = await postBinding(ownerToken, {
      principalType: 'AGENT',
      principalId: agentCId,
      roleKey: 'viewer',
      projectId: goneProjectId,
    });

    expect(res.status).toBe(404);
    expect(res.body.ret).toBe(404);
    expect(res.body.message).toBe(PROJECT_NOT_FOUND);
    expect(await bindingCount({ principalId: agentCId, projectId: goneProjectId })).toBe(0);
  });

  it('AC-26: a grantor without the role\'s keys answers 403 permissions.escalation', async () => {
    const res = await postBinding(bindingMgrToken, {
      principalType: 'AGENT',
      principalId: agentCId,
      roleKey: 'developer',
      projectId: alphaId,
    });

    expectRefusal(res, { status: 403, code: CODE.forbidden, key: 'escalation' });
  });

  it('AC-27: the refused escalation stores no binding', async () => {
    await postBinding(bindingMgrToken, {
      principalType: 'AGENT',
      principalId: agentCId,
      roleKey: 'developer',
      projectId: alphaId,
    }).expect(403);

    expect(await bindingCount({ principalId: agentCId, projectId: alphaId, role: { key: 'developer' } })).toBe(0);
  });

  it('AC-28: concurrent identical posts both answer 201 with the same binding id', async () => {
    const body = {
      principalType: 'USER',
      principalId: raceAId,
      roleKey: 'viewer',
      projectId: alphaId,
    };

    const results = await Promise.all([postBinding(ownerToken, body), postBinding(ownerToken, body)]);
    const statuses = results.map((res) => res.status);

    expect(statuses).toEqual([201, 201]);
    const ids = results.map((res) => data<BindingBody>(res).id);
    expect(ids[0]).toBe(ids[1]);
  });

  it('AC-29: the concurrent posts leave exactly one matching binding row', async () => {
    const body = {
      principalType: 'USER',
      principalId: raceBId,
      roleKey: 'viewer',
      projectId: alphaId,
    };

    await Promise.all([postBinding(ownerToken, body), postBinding(ownerToken, body)]);

    expect(await bindingCount({ principalId: raceBId, projectId: alphaId })).toBe(1);
  });
});

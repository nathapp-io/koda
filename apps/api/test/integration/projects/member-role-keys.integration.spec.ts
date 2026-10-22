/**
 * Permissions P1 web US-004 — member adds take a role key through the shared grant rules (AC-1 .. AC-10).
 *
 * One booted application for the whole file, over real HTTP + Postgres: the first registration is the
 * installation's Owner, every other actor is created through `POST /admin/users`, and the custom PROJECT
 * role is created and bound through the roles API — so every 201/403/404 below is decided by real
 * bindings and the real `RoleAdminService`.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/projects/member-role-keys.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const OWNER_EMAIL = 'owner@koda.test';
/** Boot runs the system-role seeder, so the first hook needs a generous budget. */
const BOOT_TIMEOUT_MS = 30_000;
const TIMEOUT = 30_000;

/** The `GlobalExceptionsFilter` envelope codes these routes answer with. */
const CODE = { validation: -2, forbidden: 40003, notFound: 404, conflict: 409 } as const;

const readTranslations = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en', file), 'utf8')) as Record<string, unknown>;

const MEMBERS = readTranslations('members.json');
const PERMISSIONS = readTranslations('permissions.json');

/** The sentence at `<module>.<path>.<code>`, with its `{arg}` placeholders filled in, as the filter renders it. */
function sentence(
  module: 'members' | 'permissions',
  path: string,
  code: number,
  args: Record<string, string> = {},
): string {
  const key = path === '' ? `${module}.${code}` : `${module}.${path}.${code}`;
  const node = key
    .split('.')
    .reduce<unknown>(
      (current, segment) => (typeof current === 'object' && current !== null ? (current as Record<string, unknown>)[segment] : undefined),
      { members: MEMBERS, permissions: PERMISSIONS },
    );
  if (typeof node !== 'string') throw new Error(`${key} is not declared in src/i18n/en/${module}.json`);
  return node.replace(/\{(\w+)\}/g, (placeholder, name: string) => args[name] ?? placeholder);
}

interface MemberBody {
  userId: string | null;
  email: string | null;
  role: string;
  principalType: string;
  principalId: string;
  bindings: Array<{ id: string | null; roleKey: string; roleName: string }>;
}

interface RoleBody {
  id: string;
  key: string;
  name: string;
}

describeIntegration('member role keys (US-004)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let ownerToken: string;
  let projectId: string;

  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const base = '/api/projects/team/members';
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const as = (who: string) => request(server).post(base).set(auth(who));

  /** Every binding the user holds in `team` — the "only this binding" assertions read them from the DB. */
  const bindingsInTeam = (userId: string) =>
    db.roleBinding.findMany({
      where: { principalType: 'USER', principalId: userId, projectId },
      include: { role: { select: { key: true } } },
    });

  /** Creates a user through the admin route and logs it in. */
  const createUser = async (who: string): Promise<string> => {
    const created = await request(server)
      .post('/api/admin/users')
      .set(auth('owner'))
      .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER' })
      .expect(201);
    ids[who] = data<{ id: string }>(created).id;
    tokens[who] = await loginToken(server, `${who}@koda.test`);
    return ids[who] as string;
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
    tokens.owner = ownerToken;

    const project = await request(server)
      .post('/api/projects')
      .set(auth('owner'))
      .send({ name: 'Team', slug: 'team', key: 'TEAM' })
      .expect(201);
    projectId = data<{ id: string }>(project).id;

    // padmin: a Project Admin of team; custom: a user holding a custom PROJECT role there; the targets
    // are plain MEMBER accounts with no project of their own.
    const customId = await createUser('custom');
    await createUser('padmin');
    for (const target of ['blocked', 'triager-target', 'shape-target']) await createUser(target);

    // The one role-binding path the add route has to respect: the caller holds member.add/read and
    // project.read, and none of the keys of a broader role.
    const role = await request(server)
      .post('/api/roles')
      .set(auth('owner'))
      .send({
        key: 'contributor',
        name: 'Contributor',
        scope: 'PROJECT',
        permissions: ['member.add', 'member.read', 'project.read'],
      })
      .expect(201);
    const contributorRoleId = data<RoleBody>(role).id;
    expect(contributorRoleId).toEqual(expect.any(String));

    await request(server)
      .post('/api/role-bindings')
      .set(auth('owner'))
      .send({ principalType: 'USER', principalId: customId, roleKey: 'contributor', projectId })
      .expect(201);

    // padmin joins through the legacy field, which the add route still maps to its role key.
    const added = await as('owner').send({ email: 'padmin@koda.test', role: 'ADMIN' }).expect(201);
    expect(data<MemberBody>(added)).toEqual(expect.objectContaining({ role: 'ADMIN' }));
  }, BOOT_TIMEOUT_MS);

  beforeEach(() => {
    resetThrottle(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('AC-1: a Project Admin adds a user with roleKey triager, granting only a triager binding in the project', async () => {
    const res = await as('padmin').send({ email: 'triager-target@koda.test', roleKey: 'triager' });

    expect(res.status).toBe(201);
    const bindings = await bindingsInTeam(ids['triager-target'] as string);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.role.key).toBe('triager');
    expect(bindings[0]?.projectId).toBe(projectId);
  }, TIMEOUT);

  it('AC-2: a caller holding only a custom PROJECT role is refused 403 permissions.escalation for roleKey developer', async () => {
    const res = await as('custom').send({ email: 'blocked@koda.test', roleKey: 'developer' });

    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(CODE.forbidden);
    expect(res.body.message).toBe(sentence('permissions', 'escalation', CODE.forbidden));
    // The refusal happens before the write: the target holds no binding in the project.
    expect(await bindingsInTeam(ids.blocked as string)).toEqual([]);
  }, TIMEOUT);

  it('AC-4: sending both role and roleKey is 400 members.roleAndRoleKey and writes nothing', async () => {
    const res = await as('padmin').send({
      email: 'blocked@koda.test',
      role: 'DEVELOPER',
      roleKey: 'developer',
    });

    expect(res.status).toBe(400);
    expect(res.body.ret).toBe(CODE.validation);
    expect(res.body.message).toBe(sentence('members', 'roleAndRoleKey', CODE.validation));
    expect(await bindingsInTeam(ids.blocked as string)).toEqual([]);
  }, TIMEOUT);

  it('AC-5: an unknown role key is 404 permissions.roleNotFound', async () => {
    const res = await as('padmin').send({ email: 'blocked@koda.test', roleKey: 'no-such-role' });

    expect(res.status).toBe(404);
    expect(res.body.ret).toBe(CODE.notFound);
    expect(res.body.message).toBe(sentence('permissions', 'roleNotFound', CODE.notFound));
    expect(await bindingsInTeam(ids.blocked as string)).toEqual([]);
  }, TIMEOUT);

  it('AC-6: the legacy role field only goes through the same rules — 403 permissions.escalation for DEVELOPER', async () => {
    const res = await as('custom').send({ email: 'blocked@koda.test', role: 'DEVELOPER' });

    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(CODE.forbidden);
    expect(res.body.message).toBe(sentence('permissions', 'escalation', CODE.forbidden));
    expect(await bindingsInTeam(ids.blocked as string)).toEqual([]);
  }, TIMEOUT);

  it('AC-7: a GLOBAL role inside a project is 400 permissions.scopeMismatch', async () => {
    const res = await as('padmin').send({ email: 'blocked@koda.test', roleKey: 'admin' });

    expect(res.status).toBe(400);
    expect(res.body.ret).toBe(CODE.validation);
    expect(res.body.message).toBe(sentence('permissions', 'scopeMismatch', CODE.validation, { entry: 'admin' }));
    expect(await bindingsInTeam(ids.blocked as string)).toEqual([]);
  }, TIMEOUT);

  it('AC-8: binding a role to the caller itself is 403 permissions.selfBinding', async () => {
    const res = await as('padmin').send({ email: 'padmin@koda.test', roleKey: 'viewer' });

    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(CODE.forbidden);
    expect(res.body.message).toBe(sentence('permissions', 'selfBinding', CODE.forbidden));
    // The self refusal precedes the "already a member" 409: nothing was changed for the caller.
    const own = await bindingsInTeam(ids.padmin as string);
    expect(own.map((binding) => binding.role.key)).toEqual(['project-admin']);
  }, TIMEOUT);

  it('AC-9: the 201 body carries the USER principal and exactly the new triager binding', async () => {
    const res = await as('padmin').send({ email: 'shape-target@koda.test', roleKey: 'triager' }).expect(201);

    const body = data<MemberBody>(res);
    const stored = await bindingsInTeam(ids['shape-target'] as string);
    expect(stored).toHaveLength(1);
    expect(body).toEqual(expect.objectContaining({
      userId: ids['shape-target'],
      email: 'shape-target@koda.test',
      principalType: 'USER',
      principalId: ids['shape-target'],
    }));
    expect(body.bindings).toEqual([{ id: stored[0]?.id, roleKey: 'triager', roleName: 'Triager' }]);
  }, TIMEOUT);

  it('AC-10: an admin create without a role persists the user as MEMBER', async () => {
    const res = await request(server)
      .post('/api/admin/users')
      .set(auth('owner'))
      .send({ email: 'no-role@koda.test', name: 'No role', password: TEST_PASSWORD });

    expect(res.status).toBe(201);
    const stored = await db.user.findFirstOrThrow({ where: { email: 'no-role@koda.test' }, select: { role: true } });
    expect(stored.role).toBe('MEMBER');
    // No global admin binding was granted either.
    const globalAdmins = await db.roleBinding.count({
      where: {
        principalType: 'USER',
        principalId: data<{ id: string }>(res).id,
        projectId: null,
        role: { key: { in: ['owner', 'admin'] } },
      },
    });
    expect(globalAdmins).toBe(0);
  }, TIMEOUT);
});

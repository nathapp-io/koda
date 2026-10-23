/**
 * Permissions P1 US-001 — `GET /me/permissions` answers the caller's effective keys, over real HTTP
 * and Postgres (AC-1 .. AC-8).
 *
 * The route is the web's fail-closed gate source: what it answers is exactly
 * `PermissionService.effectiveKeys` for the caller's scope — role-derived keys and `X.own` entries,
 * never an implicit or a public key. One booted application for the whole file; the first
 * registration is the installation's Owner, so the fixtures below are built as that Owner and every
 * assertion acts as a principal whose only project source is one role binding.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/me-permissions.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { IMPLICIT_KEYS, PUBLIC_KEYS } from '../../../src/permissions/catalog';
import { expandEntries } from '../../../src/permissions/entry-matcher';
import { MembershipService } from '../../../src/permissions/membership.service';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const PROJECT_SLUG = 'p';
const PROJECT_KEY = 'PONE';
/** Booting `AppModule` runs the system-role seeder, so the first hook needs a generous budget. */
const BOOT_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 30_000;

/** The `en` sentences the route's two refusals answer with, as the i18n loader resolves them. */
const PROJECTS_NOT_FOUND = (JSON.parse(
  readFileSync(join(__dirname, '../../../src/i18n/en/projects.json'), 'utf8'),
) as Record<string, string>)['404'];

interface MePermissionsBody {
  scope: 'global' | 'project';
  projectSlug: string | null;
  keys: string[];
}

describeIntegration('GET /me/permissions (US-001)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let membership: MembershipService;

  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let projectId = '';

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

  /** `GET /me/permissions` as one fixture actor, with the query exactly as given (no encoding games). */
  const mePermissions = (who: string, query = ''): request.Test =>
    request(server).get(`/api/me/permissions${query}`).set(auth(who));

  /** The keys of a 200 body, and the assertion that they arrive ascending. */
  const keysOf = (res: request.Response): string[] => {
    const body = data<MePermissionsBody>(res);
    expect(body.keys).toEqual([...body.keys].sort());
    return body.keys;
  };

  /** Creates a user through the admin route, then logs in: the token carries no bypass of its own. */
  /**
   * Permissions P1l (US-005): the create route takes no role. `'ADMIN'` means "create it, then bind
   * the global `admin` role" — the binding is the admin, and it mirrors `User.role = 'ADMIN'`.
   */
  const createUser = async (who: string, role: 'MEMBER' | 'ADMIN'): Promise<void> => {
    const created = await request(server)
      .post('/api/admin/users')
      .set(auth('root'))
      .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD })
      .expect(201);
    ids[who] = data<{ id: string }>(created).id;
    if (role === 'ADMIN') await grantRole(db, { type: 'USER', id: ids[who] as string }, 'admin');
    resetThrottle(app);
    tokens[who] = await loginToken(server, `${who}@koda.test`);
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    db = app.get<PrismaService<PrismaClient>>(PrismaService).client as PrismaClient;
    membership = app.get(MembershipService);

    const root = await request(server)
      .post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD })
      .expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;
    ids.root = (await db.user.findUniqueOrThrow({ where: { email: 'root@koda.test' } })).id;

    // `plain` holds the baseline `member` binding and nothing else; `dev` adds a developer binding in
    // one project; `gadmin` is a global admin binding with no binding in any project.
    for (const who of ['dev', 'plain']) await createUser(who, 'MEMBER');
    await createUser('gadmin', 'ADMIN');

    const project = await request(server)
      .post('/api/projects')
      .set(auth('root'))
      .send({ name: 'Project P', slug: PROJECT_SLUG, key: PROJECT_KEY })
      .expect(201);
    projectId = data<{ id: string }>(project).id;

    const agent = await request(server)
      .post('/api/agents')
      .set(auth('root'))
      .send({ name: 'Me Permissions Agent', slug: 'me-perms-agent' })
      .expect(201);
    const agentBody = data<{ apiKey: string; agent: { id: string } }>(agent);
    ids.agent = agentBody.agent.id;
    tokens.agent = agentBody.apiKey;

    // The bindings the ACs name, as the role binding they are: no legacy roster row gives any of
    // these actors its access.
    await grantRole(db, { type: 'USER', id: ids.dev }, 'developer', projectId);
    await grantRole(db, { type: 'AGENT', id: ids.agent }, 'developer', projectId);
    // The admin bindings above were written with the fixture helper, which does not touch the cache.
    await membership.invalidatePermissions();
    resetThrottle(app);
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    if (app) resetThrottle(app);
  });

  it('AC-1: a baseline member gets the member role\'s expanded keys under the global scope', async () => {
    // The premise: the baseline binding is the caller's only grant.
    expect(
      await db.roleBinding.count({ where: { principalType: 'USER', principalId: ids.plain } }),
    ).toBe(1);
    expect(
      await db.projectMember.count({ where: { userId: ids.plain } }),
    ).toBe(0);

    const res = await mePermissions('plain').expect(200);

    const body = data<MePermissionsBody>(res);
    expect(body.scope).toBe('global');
    expect(body.projectSlug).toBeNull();

    // The expectation is derived from the stored member role, not from a copy of its entry list.
    const member = await db.role.findUniqueOrThrow({ where: { key: 'member' } });
    const memberEntries = (member.permissions as string[]).filter((entry) => typeof entry === 'string');
    expect(keysOf(res)).toEqual([...expandEntries(memberEntries, 'GLOBAL')].sort());
  }, TEST_TIMEOUT_MS);

  it('AC-2: a developer of p gets the project scope with ticket.create and comment.update.own, and no ticket.delete', async () => {
    const res = await mePermissions('dev', `?project=${PROJECT_SLUG}`).expect(200);

    const body = data<MePermissionsBody>(res);
    expect(body.scope).toBe('project');
    expect(body.projectSlug).toBe(PROJECT_SLUG);
    const keys = keysOf(res);
    expect(keys).toContain('ticket.create');
    expect(keys).toContain('comment.update.own');
    expect(keys).not.toContain('ticket.delete');
  }, TEST_TIMEOUT_MS);

  it('AC-3: a global admin with no binding in p gets ticket.delete and role.binding.manage there', async () => {
    // The premise: one global `admin` binding and nothing in the project.
    expect(
      await db.roleBinding.count({
        where: { principalType: 'USER', principalId: ids.gadmin, projectId: null, role: { key: 'admin' } },
      }),
    ).toBe(1);
    expect(
      await db.roleBinding.count({ where: { principalType: 'USER', principalId: ids.gadmin, projectId } }),
    ).toBe(0);

    const res = await mePermissions('gadmin', `?project=${PROJECT_SLUG}`).expect(200);

    expect(data<MePermissionsBody>(res).scope).toBe('project');
    const keys = keysOf(res);
    expect(keys).toContain('ticket.delete');
    expect(keys).toContain('role.binding.manage');
  }, TEST_TIMEOUT_MS);

  it('AC-4: an agent holding a developer binding in p gets ticket.create there', async () => {
    // The premise: one developer binding in p, and no legacy roster row to carry it.
    expect(
      await db.roleBinding.count({ where: { principalType: 'AGENT', principalId: ids.agent, projectId } }),
    ).toBe(1);
    expect(await db.agentProject.count({ where: { agentId: ids.agent } })).toBe(0);

    const res = await mePermissions('agent', `?project=${PROJECT_SLUG}`).expect(200);

    const body = data<MePermissionsBody>(res);
    expect(body.scope).toBe('project');
    expect(body.projectSlug).toBe(PROJECT_SLUG);
    expect(keysOf(res)).toContain('ticket.create');
  }, TEST_TIMEOUT_MS);

  it('AC-5: a global owner gets role keys only — no implicit auth.me.read and no public session.login', async () => {
    const res = await mePermissions('root').expect(200);

    const keys = keysOf(res);
    expect(keys).not.toContain('auth.me.read');
    expect(keys).not.toContain('session.login');
    // The whole set is role-derived: an implicit or public key would mean the route leaked one.
    expect(keys.filter((key) => IMPLICIT_KEYS.has(key) || PUBLIC_KEYS.has(key))).toEqual([]);
    // …and it is a real set: the owner holds every global role key.
    expect(keys).toContain('role.binding.owner');
    expect(keys).toContain('user.create');
  }, TEST_TIMEOUT_MS);

  it('AC-6: an unknown project slug answers 404 projects', async () => {
    const res = await mePermissions('dev', '?project=no-such-project').expect(404);

    expect(res.body.ret).toBe(404);
    expect(res.body.message).toBe(PROJECTS_NOT_FOUND);
    expect(res.body).not.toHaveProperty('data');
  }, TEST_TIMEOUT_MS);

  it('AC-7: a user with no source in p and no global admin binding answers 403 projects', async () => {
    const res = await mePermissions('plain', `?project=${PROJECT_SLUG}`).expect(403);

    expect(res.body.ret).toBe(40003);
    // `projects` declares no `40003` sentence, so the code itself is the message.
    expect(res.body.message).toBe('projects.40003');
    expect(res.body).not.toHaveProperty('data');
  }, TEST_TIMEOUT_MS);

  it('AC-8: an empty project value is a validation refusal', async () => {
    const res = await mePermissions('dev', '?project=').expect(400);

    expect(res.body.ret).toBe(-2);
    expect(res.body).not.toHaveProperty('data');
  }, TEST_TIMEOUT_MS);
});

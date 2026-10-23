/**
 * Permissions P1 US-007 — the project, roster and assignee routes check catalog keys instead of the
 * legacy project role, `@RequiredPermission('ADMIN')` and the handler's membership/admin assertions
 * (AC-1 .. AC-18), over real HTTP + Postgres.
 *
 * One booted application for the whole file. The first registration is the installation's Owner, so
 * the fixtures (users, projects, agents, roster entries) are built as that Owner; every assertion below
 * acts as a principal whose only source in `p1` is one role binding. A global admin is a separate,
 * explicitly created ADMIN user, so "global admin" is never confused with "Owner".
 *
 * AC-8 soft-deletes `p1`, so it is declared last: every other case reads the project it deletes.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/core-project-routes.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { MembershipService } from '../../../src/permissions/membership.service';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const P1_SLUG = 'p1';
const P1_KEY = 'PONE';
const P2_SLUG = 'p2';
const P2_KEY = 'PTWO';
const TIMEOUT = 30_000;
const BOOT_TIMEOUT = 60_000;

const readI18n = (file: string): Record<string, string> =>
  JSON.parse(readFileSync(join(__dirname, `../../../src/i18n/en/${file}.json`), 'utf8')) as Record<string, string>;

/** `permissions.40003`, the sentence every refused key carries. */
const PERMISSIONS_REFUSED = readI18n('permissions')['40003'];

type RoleKey = 'developer' | 'viewer' | 'project-admin';

interface Agent {
  id: string;
  slug: string;
  apiKey: string;
}

describeIntegration('project, roster and assignee route keys (US-007)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let membership: MembershipService;

  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};
  let p1Id = '';
  /** rostered agents, by the name they are referred to below. */
  const agents: Record<string, Agent> = {};

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const agentAuth = (who: string) => ({ Authorization: `Bearer ${agents[who]?.apiKey}` });
  const asRoot = (
    method: 'get' | 'post' | 'patch' | 'delete',
    url: string,
    body?: Record<string, unknown>,
  ) => {
    const req = request(server)[method](url).set(auth('root'));
    return body === undefined ? req : req.send(body);
  };

  /** The refusal contract of one refused permission key: 403, code 40003, the exact sentence. */
  const expectPermissionsRefusal = (res: request.Response): void => {
    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(PERMISSIONS_REFUSED);
  };

  /**
   * Permissions P1l (US-005): the create route takes no role, so an account starts as a plain member.
   * `'ADMIN'` means "create it, then bind the global `admin` role" — the binding mirrors
   * `User.role = 'ADMIN'` and revokes the token minted before it, so the login comes last.
   */
  const createUser = async (who: string, role: 'MEMBER' | 'ADMIN' = 'MEMBER'): Promise<void> => {
    const created = await asRoot('post', '/api/admin/users', {
      email: `${who}@koda.test`,
      name: who,
      password: TEST_PASSWORD,
    }).expect(201);
    userIds[who] = data<{ id: string }>(created).id;
    if (role === 'ADMIN') await bindGlobal(who, 'admin');
    resetThrottle(app);
    tokens[who] = await loginToken(server, `${who}@koda.test`);
  };

  /** The binding that is the caller's only source in p1. */
  const bind = (who: string, roleKey: RoleKey): Promise<unknown> =>
    membership.createBinding(
      { principal: { type: 'USER', id: userIds[who] }, roleKey, projectId: p1Id },
      { type: 'SYSTEM', id: 'test' },
    );

  /** The global binding that makes a principal a global admin (role `admin`, no project). */
  const bindGlobal = (who: string, roleKey: string): Promise<unknown> =>
    membership.createBinding(
      { principal: { type: 'USER', id: userIds[who] }, roleKey, projectId: null },
      { type: 'SYSTEM', id: 'test' },
    );

  /** An agent created by the Owner; created OFFLINE-free and not yet on any roster. */
  const createAgent = async (slug: string): Promise<Agent> => {
    const created = await asRoot('post', '/api/agents', { name: slug, slug }).expect(201);
    const body = data<{ agent: { id: string; slug: string }; apiKey: string }>(created);
    agents[slug] = { ...body.agent, apiKey: body.apiKey };
    return agents[slug] as Agent;
  };

  /** Puts the agent on p1's roster: a viewer binding in the project, as the Owner. */
  const roster = async (slug: string): Promise<void> => {
    await membership.createBinding(
      { principal: { type: 'AGENT', id: agents[slug]?.id ?? '' }, roleKey: 'viewer', projectId: p1Id },
      { type: 'SYSTEM', id: 'test' },
    );
  };

  /** The roster bindings the agent holds in p1 — what "no binding created" is measured against. */
  const rosterBindings = (agentSlug: string) =>
    db.roleBinding.findMany({
      where: { principalType: 'AGENT', principalId: agents[agentSlug]?.id ?? '', projectId: p1Id },
      select: { id: true, role: { select: { key: true } } },
    });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    server = app.getHttpServer();
    db = app.get<PrismaService<PrismaClient>>(PrismaService).client as PrismaClient;
    membership = app.get(MembershipService);

    const root = await request(server)
      .post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD })
      .expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;

    for (const who of ['developer', 'viewer', 'padmin']) await createUser(who);
    // AC-2's caller: a global admin, and a source in no project at all.
    await createUser('gadmin', 'ADMIN');
    // US-001 AC-8's caller: a global admin through a global `admin` binding. A global binding is
    // not a project access source, so it also holds a `viewer` binding in p1 — the project route
    // is only reachable with a source in the project.
    await createUser('globaladmin');

    const project = await asRoot('post', '/api/projects', {
      name: 'P1',
      slug: P1_SLUG,
      key: P1_KEY,
    }).expect(201);
    p1Id = data<{ id: string }>(project).id;
    // AC-18's second project: it exists and nobody but the Owner has a source in it.
    await asRoot('post', '/api/projects', { name: 'P2', slug: P2_SLUG, key: P2_KEY }).expect(201);

    await bind('developer', 'developer');
    await bind('viewer', 'viewer');
    await bind('padmin', 'project-admin');
    await bind('globaladmin', 'viewer');
    await bindGlobal('globaladmin', 'admin');
    // The global admin binding promotes the user's legacy role and revokes the token minted at
    // creation, so the caller logs in again before it calls anything.
    resetThrottle(app);
    tokens['globaladmin'] = await loginToken(server, 'globaladmin@koda.test');

    for (const slug of ['roster-a', 'roster-b', 'peer', 'removable', 'addable', 'blocked']) await createAgent(slug);
    for (const slug of ['roster-a', 'roster-b', 'peer', 'removable']) await roster(slug);
  }, BOOT_TIMEOUT);

  afterAll(async () => {
    await app?.close();
  });

  // -------------------------------------------------------------------------
  // AC-1 .. AC-2 — POST /projects needs project.create, a global key
  // -------------------------------------------------------------------------

  it('AC-1: a non-admin user is refused by POST /projects with 403 permissions', async () => {
    const res = await request(server)
      .post('/api/projects')
      .set(auth('developer'))
      .send({ name: 'Not An Admin', slug: 'not-an-admin', key: 'NAA' });

    expectPermissionsRefusal(res);
    await expect(db.project.count({ where: { slug: 'not-an-admin' } })).resolves.toBe(0);
  }, TIMEOUT);

  it('AC-2: a global admin creates a project with 201', async () => {
    const res = await request(server)
      .post('/api/projects')
      .set(auth('gadmin'))
      .send({ name: 'Global Admin Project', slug: 'gadmin-project', key: 'GAP' })
      .expect(201);

    expect(data<{ slug: string }>(res).slug).toBe('gadmin-project');
    await expect(db.project.count({ where: { slug: 'gadmin-project', deletedAt: null } })).resolves.toBe(1);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-3 .. AC-5 — reads inside a project, as a viewer binding
  // -------------------------------------------------------------------------

  it('AC-3: a viewer binding alone reads the project with GET /projects/p1', async () => {
    const res = await request(server).get(`/api/projects/${P1_SLUG}`).set(auth('viewer')).expect(200);

    expect(data<{ slug: string }>(res).slug).toBe(P1_SLUG);
  }, TIMEOUT);

  it('AC-4: a viewer binding alone reads the roster with GET /projects/p1/agents', async () => {
    const res = await request(server)
      .get(`/api/projects/${P1_SLUG}/agents`)
      .set(auth('viewer'))
      .expect(200);

    const body = data<{ items: { slug: string }[] }>(res);
    expect(body.items.map((row) => row.slug).sort()).toEqual(['peer', 'removable', 'roster-a', 'roster-b']);
  }, TIMEOUT);

  it('AC-5: a viewer binding alone reads the assignees with GET /projects/p1/assignees', async () => {
    const res = await request(server)
      .get(`/api/projects/${P1_SLUG}/assignees`)
      .set(auth('viewer'))
      .expect(200);

    const body = data<{ items: unknown[] }>(res);
    expect(Array.isArray(body.items)).toBe(true);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-6 .. AC-7 — PATCH /projects/:slug needs project.update
  // -------------------------------------------------------------------------

  it('AC-6: a project-admin binding alone renames the project with PATCH /projects/p1', async () => {
    const res = await request(server)
      .patch(`/api/projects/${P1_SLUG}`)
      .set(auth('padmin'))
      .send({ name: 'Renamed' })
      .expect(200);

    expect(data<{ name: string }>(res).name).toBe('Renamed');
    await expect(
      db.project.findUniqueOrThrow({ where: { id: p1Id }, select: { name: true } }),
    ).resolves.toEqual({ name: 'Renamed' });
  }, TIMEOUT);

  it('AC-7: a developer binding alone is refused by PATCH /projects/p1 with 403 permissions', async () => {
    const before = await db.project.findUniqueOrThrow({ where: { id: p1Id }, select: { name: true } });

    const res = await request(server)
      .patch(`/api/projects/${P1_SLUG}`)
      .set(auth('developer'))
      .send({ name: 'Developer Rename' });

    expectPermissionsRefusal(res);
    await expect(
      db.project.findUniqueOrThrow({ where: { id: p1Id }, select: { name: true } }),
    ).resolves.toEqual(before);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-9 .. AC-10 — the CI webhook token is a project secret a `*.read` role must not reach
  // -------------------------------------------------------------------------

  it('AC-9: a developer binding alone is refused the CI webhook token with 403 permissions', async () => {
    const res = await request(server)
      .get(`/api/projects/${P1_SLUG}/ci-webhook-token`)
      .set(auth('developer'));

    expectPermissionsRefusal(res);
  }, TIMEOUT);

  it('AC-10: a project-admin binding alone reads the CI webhook token with 200', async () => {
    const res = await request(server)
      .get(`/api/projects/${P1_SLUG}/ci-webhook-token`)
      .set(auth('padmin'))
      .expect(200);

    expect(data<Record<string, unknown>>(res)).toHaveProperty('ciWebhookToken');
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-11 .. AC-12 — an agent joins the roster through a viewer binding (role.binding.manage)
  //
  // Permissions P1 US-003 deleted the roster POST; a viewer binding for the agent in the project is
  // what puts it on the roster, and `/role-bindings` is the route that writes it.
  // -------------------------------------------------------------------------

  it('AC-11: a developer binding alone is refused a viewer binding for an agent and writes no binding', async () => {
    const res = await request(server)
      .post('/api/role-bindings')
      .set(auth('developer'))
      .send({ principalType: 'AGENT', principalId: agents['blocked']?.id, roleKey: 'viewer', projectId: p1Id });

    expectPermissionsRefusal(res);
    await expect(rosterBindings('blocked')).resolves.toEqual([]);
  }, TIMEOUT);

  it('AC-12: a project-admin binding alone puts an agent on the roster with 201', async () => {
    const res = await request(server)
      .post('/api/role-bindings')
      .set(auth('padmin'))
      .send({ principalType: 'AGENT', principalId: agents['addable']?.id, roleKey: 'viewer', projectId: p1Id })
      .expect(201);

    expect(data<{ principalId: string; roleKey: string }>(res)).toMatchObject({
      principalId: agents['addable']?.id,
      roleKey: 'viewer',
    });
    await expect(rosterBindings('addable')).resolves.toEqual([
      expect.objectContaining({ role: { key: 'viewer' } }),
    ]);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-13 .. AC-14 — an agent leaves the roster through its binding (role.binding.manage)
  // -------------------------------------------------------------------------

  it('AC-13: a project-admin binding alone revokes a rostered agent\'s binding with no open tickets, 204', async () => {
    const [binding] = await rosterBindings('removable');
    if (!binding) throw new Error('removable holds no binding to revoke');

    await request(server)
      .delete(`/api/role-bindings/${binding.id}`)
      .set(auth('padmin'))
      .expect(204);

    await expect(rosterBindings('removable')).resolves.toEqual([]);
  }, TIMEOUT);

  it('AC-14: a developer binding alone is refused the agent binding delete with 403 permissions', async () => {
    const [binding] = await rosterBindings('roster-a');
    if (!binding) throw new Error('roster-a holds no binding to revoke');

    const res = await request(server)
      .delete(`/api/role-bindings/${binding.id}`)
      .set(auth('developer'));

    expectPermissionsRefusal(res);
    await expect(rosterBindings('roster-a')).resolves.toEqual([
      expect.objectContaining({ role: { key: 'viewer' } }),
    ]);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-15 .. AC-17 — PATCH /projects/:slug/agents/:agentSlug is the global agent.update key, or the
  // agent itself. US-001 folds the project-scoped `project.agent.update` into the global
  // `agent.update`, so a project admin is refused (AC-17 / US-001 AC-7) and a global admin is not.
  // -------------------------------------------------------------------------

  it('AC-15 (US-001 AC-9): a rostered agent updates its own status with 200', async () => {
    const res = await request(server)
      .patch(`/api/projects/${P1_SLUG}/agents/roster-b`)
      .set(agentAuth('roster-b'))
      .send({ status: 'OFFLINE' })
      .expect(200);

    expect(data<{ slug: string; status: string }>(res)).toMatchObject({ slug: 'roster-b', status: 'OFFLINE' });
  }, TIMEOUT);

  it("AC-16: a rostered agent is refused by PATCH on another rostered agent's status with 403 permissions", async () => {
    const res = await request(server)
      .patch(`/api/projects/${P1_SLUG}/agents/roster-a`)
      .set(agentAuth('peer'))
      .send({ status: 'OFFLINE' });

    expectPermissionsRefusal(res);
    await expect(
      db.agent.findUniqueOrThrow({ where: { id: agents['roster-a']?.id ?? '' }, select: { status: true } }),
    ).resolves.toEqual({ status: 'ACTIVE' });
  }, TIMEOUT);

  it("AC-17 (US-001 AC-7): a project-admin binding alone is refused by PATCH on a rostered agent's status with 403 permissions", async () => {
    const res = await request(server)
      .patch(`/api/projects/${P1_SLUG}/agents/roster-a`)
      .set(auth('padmin'))
      .send({ status: 'OFFLINE' });

    expectPermissionsRefusal(res);
    await expect(
      db.agent.findUniqueOrThrow({ where: { id: agents['roster-a']?.id ?? '' }, select: { status: true } }),
    ).resolves.toEqual({ status: 'ACTIVE' });
  }, TIMEOUT);

  it("US-001 AC-8: a global admin updates a rostered agent's status with 200", async () => {
    const res = await request(server)
      .patch(`/api/projects/${P1_SLUG}/agents/roster-a`)
      .set(auth('globaladmin'))
      .send({ status: 'OFFLINE' })
      .expect(200);

    expect(data<{ slug: string; status: string }>(res)).toMatchObject({ slug: 'roster-a', status: 'OFFLINE' });
    await expect(
      db.agent.findUniqueOrThrow({ where: { id: agents['roster-a']?.id ?? '' }, select: { status: true } }),
    ).resolves.toEqual({ status: 'OFFLINE' });
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-18 — GET /projects keeps its access-filtered listing
  // -------------------------------------------------------------------------

  it('AC-18: GET /projects lists p1 and not p2 for a user with a developer binding only in p1', async () => {
    const res = await request(server).get('/api/projects').set(auth('developer')).expect(200);

    const slugs = data<{ slug: string }[]>(res).map((row) => row.slug);
    expect(slugs).toContain(P1_SLUG);
    expect(slugs).not.toContain(P2_SLUG);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-8 — declared last: it soft-deletes p1
  // -------------------------------------------------------------------------

  it('AC-8: a project-admin binding alone soft-deletes p1 with 204', async () => {
    await request(server).delete(`/api/projects/${P1_SLUG}`).set(auth('padmin')).expect(204);

    const row = await db.project.findUniqueOrThrow({ where: { id: p1Id }, select: { deletedAt: true } });
    expect(row.deletedAt).not.toBeNull();
  }, TIMEOUT);
});

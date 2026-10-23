/**
 * Permissions P1 US-009 — the `/agents` routes check their catalog keys, pickup is authorized by the
 * **target** agent's project keys, and legacy role changes grant no keys (AC-1 .. AC-20),
 * over real HTTP + Postgres.
 *
 * One booted application for the whole file. The first registration is the installation's Owner, so
 * the fixtures (users, projects, role bindings, agent roster rows) are built as that Owner; every
 * assertion below acts as a principal whose only source in `p1` is one role binding (users) or one
 * legacy `AgentProject` row, with and without an `AgentRoleEntry` (agents). A global admin is a
 * separate, explicitly created ADMIN user, so "global admin" is never confused with "Owner".
 *
 * The agent routes carry a 10/min throttle, so the counters are dropped before every test: the
 * throttle is not what these ACs are about.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/core-agent-routes.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
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

/** `permissions.40003`, the sentence a refused permission key carries. */
const PERMISSIONS_REFUSED = readI18n('permissions')['40003'];
/** `agents.40003`, the sentence a refused `/agents` rule that is not a key carries. */
const AGENTS_REFUSED = readI18n('agents')['40003'];

type RoleKey = 'developer' | 'viewer' | 'project-admin';

interface AgentFixture {
  id: string;
  slug: string;
  apiKey: string;
}

interface AgentProfile {
  id: string;
  slug: string;
  name: string;
  capabilities: { capability: string }[];
}

describeIntegration('agent route keys (US-009)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let membership: MembershipService;

  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};
  let p1Id = '';
  let p2Id = '';

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const agentAuth = (slug: string) => ({ Authorization: `Bearer ${tokens[slug]}` });

  /** The refusal contract of one refused permission key: 403, code 40003, the exact sentence. */
  const expectPermissionsRefusal = (res: request.Response): void => {
    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(PERMISSIONS_REFUSED);
  };

  /** A refusal that is not a key: 403, code 40003, the `agents` sentence. */
  const expectAgentsRefusal = (res: request.Response): void => {
    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(AGENTS_REFUSED);
  };

  /**
   * Permissions P1l (US-005): the create route takes no role, so an account starts as a plain member.
   * `'ADMIN'` means "create it, then bind the global `admin` role" — the binding mirrors
   * `User.role = 'ADMIN'` and revokes the token minted before it, so the login comes last.
   */
  const createUser = async (who: string, role: 'MEMBER' | 'ADMIN' = 'MEMBER'): Promise<void> => {
    const created = await request(server)
      .post('/api/admin/users')
      .set(auth('root'))
      .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD })
      .expect(201);
    userIds[who] = data<{ id: string }>(created).id;
    if (role === 'ADMIN') await bindGlobal(who, 'admin');
    resetThrottle(app);
    tokens[who] = await loginToken(server, `${who}@koda.test`);
  };

  /** The global binding that makes a principal a global admin (role `admin`, no project). */
  const bindGlobal = (who: string, roleKey: string): Promise<unknown> =>
    membership.createBinding(
      { principal: { type: 'USER', id: userIds[who] }, roleKey, projectId: null },
      { type: 'SYSTEM', id: 'test' },
    );

  /** The binding that is the caller's only source in p1. */
  const bind = (who: string, roleKey: RoleKey): Promise<unknown> =>
    membership.createBinding(
      { principal: { type: 'USER', id: userIds[who] }, roleKey, projectId: p1Id },
      { type: 'SYSTEM', id: 'test' },
    );

  /**
   * An agent created through the route as the Owner, then given explicit
   * viewer/developer bindings (`roster: 'p1'`) and inert `AgentRoleEntry` data (`legacyRole`). The rows are
   * written after the agent could already have been cached by an earlier check, so the permission
   * cache is invalidated afterwards.
   */
  const createAgent = async (
    slug: string,
    legacy: { roster?: 'p1'; legacyRole?: 'DEVELOPER' } = {},
  ): Promise<AgentFixture> => {
    const created = await request(server)
      .post('/api/agents')
      .set(auth('root'))
      .send({ name: slug, slug })
      .expect(201);
    const body = data<{ apiKey: string; agent: { id: string; slug: string } }>(created);
    const fixture: AgentFixture = { ...body.agent, apiKey: body.apiKey };
    tokens[slug] = body.apiKey;

    if (legacy.roster) {
      await grantRole(db, { type: 'AGENT', id: fixture.id }, 'viewer', p1Id);
      if (legacy.legacyRole) await grantRole(db, { type: 'AGENT', id: fixture.id }, 'developer', p1Id);
    }
    if (legacy.legacyRole) {
      await db.agentRoleEntry.create({ data: { agentId: fixture.id, role: legacy.legacyRole } });
    }
    await membership.invalidatePermissions();
    resetThrottle(app);
    return fixture;
  };

  /** An agent's profile read through the route as a global admin. */
  const profile = async (slug: string): Promise<AgentProfile> => {
    const res = await request(server).get(`/api/agents/${slug}`).set(auth('gadmin')).expect(200);
    return data<AgentProfile>(res);
  };

  /** The one thing this file ever needs from a ticket create: its status and permission refusal. */
  const createTicketAs = (slug: string) =>
    request(server)
      .post(`/api/projects/${P1_SLUG}/tickets`)
      .set(agentAuth(slug))
      .send({ type: 'BUG', title: `from ${slug}` });

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

    // `plain` holds no binding at all; `gadmin` is the installation's other global admin.
    for (const who of ['developer', 'padmin', 'plain']) await createUser(who);
    await createUser('gadmin', 'ADMIN');

    const projectRes = await request(server)
      .post('/api/projects')
      .set(auth('root'))
      .send({ name: 'P1', slug: P1_SLUG, key: P1_KEY })
      .expect(201);
    p1Id = data<{ id: string }>(projectRes).id;

    const otherRes = await request(server)
      .post('/api/projects')
      .set(auth('root'))
      .send({ name: 'P2', slug: P2_SLUG, key: P2_KEY })
      .expect(201);
    p2Id = data<{ id: string }>(otherRes).id;

    await bind('developer', 'developer');
    await bind('padmin', 'project-admin');

    // AC-9 and AC-10: a roster binding and no AgentRoleEntry — listed and read by those cases.
    await createAgent('rosterless-agent', { roster: 'p1' });
    // AC-14: the same shape, kept role-less so its refusal cannot depend on test order.
    await createAgent('roster-only-agent', { roster: 'p1' });
    // AC-15: a roster row and a legacy DEVELOPER entry — the pickup target that holds the key.
    const rosterDev = await createAgent('roster-dev-agent', { roster: 'p1', legacyRole: 'DEVELOPER' });
    // AC-16 and AC-19: a DEVELOPER entry and no source in p1 (nor in p2).
    await createAgent('dev-only-agent', { legacyRole: 'DEVELOPER' });

    // A capability to score on, so the AC-10 "capabilities are unchanged" assertion compares two
    // non-empty lists rather than two empty ones.
    await db.agentCapabilityEntry.create({ data: { agentId: rosterDev.id, capability: 'typescript' } });
    await membership.invalidatePermissions();
    resetThrottle(app);
  }, BOOT_TIMEOUT);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    // The `/agents` controller throttles at 10/min; the counters are reset so a suite of twenty
    // requests never answers 429 for a reason no AC here is about.
    if (app) resetThrottle(app);
  });

  // -------------------------------------------------------------------------
  // AC-1 / AC-2 — POST /agents needs the global agent.create
  // -------------------------------------------------------------------------

  it('AC-1: a non-admin user is refused by POST /agents with 403 permissions and no agent is created', async () => {
    const before = await db.agent.count();

    const res = await request(server)
      .post('/api/agents')
      .set(auth('developer'))
      .send({ name: 'Refused Agent', slug: 'refused-agent' });

    expectPermissionsRefusal(res);
    await expect(db.agent.count()).resolves.toBe(before);
    await expect(db.agent.findUnique({ where: { slug: 'refused-agent' } })).resolves.toBeNull();
  }, TIMEOUT);

  it('AC-2: a global admin creates an agent with POST /agents, 201', async () => {
    const res = await request(server)
      .post('/api/agents')
      .set(auth('gadmin'))
      .send({ name: 'Created Agent', slug: 'created-by-gadmin' })
      .expect(201);

    const body = data<{ apiKey: string; agent: { slug: string; id: string } }>(res);
    expect(body.agent.slug).toBe('created-by-gadmin');
    expect(body.apiKey).toMatch(/^[a-f0-9]{64}$/);
    await expect(db.agent.findUnique({ where: { slug: 'created-by-gadmin' } })).resolves.not.toBeNull();
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-3 / AC-4 — GET /agents and GET /agents/:slug need the global agent.read
  // -------------------------------------------------------------------------

  it('AC-3: a user with no binding lists the agents with 200', async () => {
    const res = await request(server).get('/api/agents').set(auth('plain')).expect(200);

    const agents = data<{ slug: string }[]>(res);
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.map((agent) => agent.slug)).toContain('rosterless-agent');
  }, TIMEOUT);

  it('AC-4: a user with no binding reads one agent with 200', async () => {
    const res = await request(server).get('/api/agents/rosterless-agent').set(auth('plain')).expect(200);

    expect(data<AgentProfile>(res).slug).toBe('rosterless-agent');
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-5 / AC-6 — GET /agents/me is agents-only
  // -------------------------------------------------------------------------

  it('AC-5: a user is refused by GET /agents/me with 403 agents', async () => {
    const res = await request(server).get('/api/agents/me').set(auth('plain'));

    expectAgentsRefusal(res);
  }, TIMEOUT);

  it('AC-6: an agent reads its own profile with 200', async () => {
    const res = await request(server).get('/api/agents/me').set(agentAuth('roster-dev-agent')).expect(200);

    const me = data<AgentProfile>(res);
    expect(me.slug).toBe('roster-dev-agent');
    expect(me.id).toBe((await db.agent.findUniqueOrThrow({ where: { slug: 'roster-dev-agent' } })).id);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-7 .. AC-10, AC-13 — the management routes need their global key
  // -------------------------------------------------------------------------

  it('AC-7: a project-admin binding alone is refused by PATCH /agents/<slug> with 403 permissions and the name is unchanged', async () => {
    const before = await profile('roster-dev-agent');

    const res = await request(server)
      .patch('/api/agents/roster-dev-agent')
      .set(auth('padmin'))
      .send({ name: 'Renamed' });

    expectPermissionsRefusal(res);
    await expect(profile('roster-dev-agent')).resolves.toEqual(expect.objectContaining({ name: before.name }));
    expect(before.name).not.toBe('Renamed');
  }, TIMEOUT);

  it('AC-8: a non-admin user is refused by DELETE /agents/<slug> with 403 permissions and the agent stays', async () => {
    const res = await request(server).delete('/api/agents/roster-dev-agent').set(auth('developer'));

    expectPermissionsRefusal(res);
    // `Agent` is hard-deleted, so "the agent stays" is a row count, not a `deletedAt` column.
    await expect(db.agent.count({ where: { slug: 'roster-dev-agent' } })).resolves.toBe(1);
    await expect(profile('roster-dev-agent')).resolves.toEqual(expect.objectContaining({ slug: 'roster-dev-agent' }));
  }, TIMEOUT);

  it('AC-9: a non-admin user is refused by POST /agents/<slug>/rotate-key with 403 permissions and the key is unchanged', async () => {
    const before = await db.agent.findUniqueOrThrow({
      where: { slug: 'roster-dev-agent' },
      select: { apiKeyHash: true },
    });

    const res = await request(server).post('/api/agents/roster-dev-agent/rotate-key').set(auth('developer'));

    expectPermissionsRefusal(res);
    await expect(
      db.agent.findUniqueOrThrow({ where: { slug: 'roster-dev-agent' }, select: { apiKeyHash: true } }),
    ).resolves.toEqual(before);
  }, TIMEOUT);

  it('AC-10: a non-admin user is refused by PATCH /agents/<slug>/update-capabilities with 403 permissions and the capabilities are unchanged', async () => {
    const before = await profile('roster-dev-agent');

    const res = await request(server)
      .patch('/api/agents/roster-dev-agent/update-capabilities')
      .set(auth('developer'))
      .send({ capabilities: ['golang'] });

    expectPermissionsRefusal(res);
    await expect(profile('roster-dev-agent')).resolves.toEqual(
      expect.objectContaining({ capabilities: before.capabilities }),
    );
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-14 .. AC-20 — pickup is authorized by the target agent's project keys
  // -------------------------------------------------------------------------

  it('AC-14: a roster-only agent is refused its own pickup with 403 permissions', async () => {
    const res = await request(server)
      .get('/api/agents/roster-only-agent/pickup')
      .query({ project: P1_SLUG })
      .set(agentAuth('roster-only-agent'));

    expectPermissionsRefusal(res);
  }, TIMEOUT);

  it('AC-15: an agent with a roster row and an AgentRoleEntry DEVELOPER gets 200 from its own pickup', async () => {
    const res = await request(server)
      .get('/api/agents/roster-dev-agent/pickup')
      .query({ project: P1_SLUG })
      .set(agentAuth('roster-dev-agent'))
      .expect(200);

    // The suggestion itself is orthogonal: this AC is about the target agent's keys admitting it.
    expect(res.body).toHaveProperty('data');
  }, TIMEOUT);

  it('AC-16: an agent with an AgentRoleEntry DEVELOPER and no source in p2 is refused with 403 permissions', async () => {
    const res = await request(server)
      .get('/api/agents/dev-only-agent/pickup')
      .query({ project: P2_SLUG })
      .set(agentAuth('dev-only-agent'));

    expectPermissionsRefusal(res);
    await expect(db.project.count({ where: { id: p2Id, deletedAt: null } })).resolves.toBe(1);
    await expect(
      db.agentProject.count({ where: { agentId: (await db.agent.findUniqueOrThrow({ where: { slug: 'dev-only-agent' } })).id } }),
    ).resolves.toBe(0);
  }, TIMEOUT);

  it('AC-17: a user whose only source in p1 is a developer binding is refused pickup with 403 agents', async () => {
    const res = await request(server)
      .get('/api/agents/roster-dev-agent/pickup')
      .query({ project: P1_SLUG })
      .set(auth('developer'));

    expectAgentsRefusal(res);
  }, TIMEOUT);

  it('AC-18: an agent gets 400 from its own pickup when the project query is missing', async () => {
    const res = await request(server)
      .get('/api/agents/roster-dev-agent/pickup')
      .set(agentAuth('roster-dev-agent'));

    expect(res.status).toBe(400);
  }, TIMEOUT);

  it('AC-19: a global admin is refused pickup with 403 permissions for a target agent with an AgentRoleEntry DEVELOPER and no source in p1', async () => {
    const res = await request(server)
      .get('/api/agents/dev-only-agent/pickup')
      .query({ project: P1_SLUG })
      .set(auth('gadmin'));

    expectPermissionsRefusal(res);
  }, TIMEOUT);

  it('AC-20: the same admin pickup answers 200 after the target gains a p1 roster row and the cache is invalidated', async () => {
    const agent = await createAgent('late-roster-agent', { legacyRole: 'DEVELOPER' });

    const refused = await request(server)
      .get('/api/agents/late-roster-agent/pickup')
      .query({ project: P1_SLUG })
      .set(auth('gadmin'));
    expectPermissionsRefusal(refused);

    await grantRole(db, { type: 'AGENT', id: agent.id }, 'viewer', p1Id);
    await grantRole(db, { type: 'AGENT', id: agent.id }, 'developer', p1Id);
    await membership.invalidatePermissions();

    const res = await request(server)
      .get('/api/agents/late-roster-agent/pickup')
      .query({ project: P1_SLUG })
      .set(auth('gadmin'))
      .expect(200);

    expect(res.body).toHaveProperty('data');
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // B2 (whole-branch review) — removing a bound agent ends its pickup at once
  // -------------------------------------------------------------------------

  it('B2: a warmed-up rostered agent is refused its own pickup right after its binding is revoked', async () => {
    // Warm the binding-based decision, then revoke the binding through the route (Permissions P1 US-003
    // deleted the roster DELETE; removing an agent is deleting its bindings).
    const agent = await createAgent('b2-removed-agent', { roster: 'p1', legacyRole: 'DEVELOPER' });

    await request(server)
      .get('/api/agents/b2-removed-agent/pickup')
      .query({ project: P1_SLUG })
      .set(agentAuth('b2-removed-agent'))
      .expect(200);

    const bindings = await db.roleBinding.findMany({
      where: { principalType: 'AGENT', principalId: agent.id, projectId: p1Id },
      select: { id: true },
    });
    expect(bindings.length).toBeGreaterThan(0);
    for (const binding of bindings) {
      await request(server)
        .delete(`/api/role-bindings/${binding.id}`)
        .set(auth('padmin'))
        .expect(204);
    }

    await expect(
      db.roleBinding.count({ where: { principalType: 'AGENT', principalId: agent.id, projectId: p1Id } }),
    ).resolves.toBe(0);

    const refused = await request(server)
      .get('/api/agents/b2-removed-agent/pickup')
      .query({ project: P1_SLUG })
      .set(agentAuth('b2-removed-agent'));

    expectPermissionsRefusal(refused);
  }, TIMEOUT);
});

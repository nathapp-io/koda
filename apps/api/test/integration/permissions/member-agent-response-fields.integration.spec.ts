/**
 * Permissions P1l US-006 — member, roster and agent responses lose their legacy fields (AC-1 .. AC-10).
 *
 * The legacy values were display-only: a member's page carried `canManage` and the caller's
 * `viewerRole`, each member row carried a display `role`, the agent roster carried a `scoping` flag and
 * per-agent `roles`, and every `AgentResponseDto` carried `AgentRoleDto[]`. New data has no
 * `AgentRoleEntry` row at all, so those fields answered legacy values the bindings already describe.
 *
 * One booted application for the whole file, over real HTTP + Postgres. The first registration is the
 * installation's Owner; users are created through `POST /admin/users` and receive their bindings
 * through `MembershipService.createBinding` (the same write the role-bindings route uses), which
 * invalidates the permission cache for the token minted after it. A "global admin" is a user with a
 * global `admin` binding, never the Owner, so the assertion cannot pass on an owner-only shortcut.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/member-agent-response-fields.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { MembershipService } from '../../../src/permissions/membership.service';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const PROJECT = { slug: 'fields', key: 'FLD', name: 'Fields' } as const;
/** Boot runs the system-role seeder, so the first hook needs a generous budget. */
const BOOT_TIMEOUT_MS = 60_000;
const TIMEOUT = 30_000;

/** The six fields a member page carries, and no other. */
const MEMBER_PAGE_FIELDS = ['current', 'hasNext', 'hasPrev', 'records', 'size', 'total'];

/** One member row as the listing returns it, typed with only the fields these cases read. */
interface MemberRow {
  userId: string | null;
  principalType: 'USER' | 'AGENT';
  principalId: string;
  bindings: { id: string; roleKey: string; roleName: string }[];
}

interface AgentProfile {
  id: string;
  slug: string;
  capabilities: { capability: string }[];
}

describeIntegration('member, roster and agent responses carry no legacy fields (US-006)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let membership: MembershipService;

  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};
  const agents: Record<string, { id: string; apiKey: string }> = {};
  let projectId = '';

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const membersUrl = `/api/projects/${PROJECT.slug}/members`;
  const rosterUrl = `/api/projects/${PROJECT.slug}/agents`;

  /** The members page as the route answers it, so the same page can be read by several cases. */
  const memberPage = async (who: string): Promise<Record<string, unknown>> => {
    const res = await request(server).get(membersUrl).set(auth(who)).expect(200);
    return data<Record<string, unknown>>(res);
  };

  /** A user created by the Owner; a `globalAdmin` one also receives the global `admin` binding. */
  const createUser = async (who: string, globalAdmin = false): Promise<void> => {
    const created = await request(server)
      .post('/api/admin/users')
      .set(auth('root'))
      .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD })
      .expect(201);
    userIds[who] = data<{ id: string }>(created).id;
    if (globalAdmin) await bind('USER', userIds[who] as string, 'admin', null);
    resetThrottle(app);
    // The login comes after the binding: a binding write can revoke a token minted before it.
    tokens[who] = await loginToken(server, `${who}@koda.test`);
  };

  /** One binding, written through the service the role-bindings route delegates to. */
  const bind = (
    principalType: 'USER' | 'AGENT',
    principalId: string,
    roleKey: string,
    projectIdOfBinding: string | null,
  ) => membership.createBinding(
    { principal: { type: principalType, id: principalId }, roleKey, projectId: projectIdOfBinding },
    { type: 'SYSTEM', id: 'test' },
  );

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
    resetThrottle(app);

    const project = await request(server)
      .post('/api/projects')
      .set(auth('root'))
      .send({ name: PROJECT.name, slug: PROJECT.slug, key: PROJECT.key })
      .expect(201);
    projectId = data<{ id: string }>(project).id;

    // `pa` is P's only Project Admin: AC-1 .. AC-3 and AC-10's caller.
    await createUser('pa');
    await bind('USER', userIds.pa as string, 'project-admin', projectId);
    tokens.pa = await loginToken(server, 'pa@koda.test');

    // AC-7 and AC-9's caller: a global admin, and a source in no project of its own.
    await createUser('gadmin', true);
    // AC-4's caller: an account with no binding in P at all.
    await createUser('outsider');
    // AC-10's target: an existing account that is not a member of P.
    await createUser('addable');

    // AC-5 .. AC-8's agent: a `viewer` binding in P is what puts it on the roster.
    const createdAgent = await request(server)
      .post('/api/agents')
      .set(auth('root'))
      .send({ name: 'Roster Bot', slug: 'roster-bot', capabilities: ['typescript'] })
      .expect(201);
    const payload = data<{ agent: AgentProfile; apiKey: string }>(createdAgent);
    agents.roster = { id: payload.agent.id, apiKey: payload.apiKey };
    await bind('AGENT', agents.roster.id, 'viewer', projectId);
  }, BOOT_TIMEOUT_MS);

  beforeEach(() => {
    resetThrottle(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  // -------------------------------------------------------------------------
  // AC-1 .. AC-4 — the members page is the page alone, and its rows carry bindings only
  // -------------------------------------------------------------------------

  it('AC-1: a Project Admin of P gets a members page whose keys are exactly the six page fields', async () => {
    const page = await memberPage('pa');

    expect(Object.keys(page).sort()).toEqual(MEMBER_PAGE_FIELDS);
  }, TIMEOUT);

  it('AC-2: no record of that page has a role property', async () => {
    const page = await memberPage('pa');
    const records = page.records as MemberRow[];

    // The page is not empty, so "no record has a role" is not vacuous.
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) expect(record).not.toHaveProperty('role');
  }, TIMEOUT);

  it('AC-3: every binding chip of that page names its binding row with a string id', async () => {
    const page = await memberPage('pa');
    const chips = (page.records as MemberRow[]).flatMap((record) => record.bindings);

    // P's Project Admin holds one binding, so there is a chip to check.
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      expect(typeof chip.id).toBe('string');
      expect(chip.id).not.toBeNull();
    }
  }, TIMEOUT);

  it('AC-4: a user without access to P gets 403 projects from the members page', async () => {
    const res = await request(server).get(membersUrl).set(auth('outsider'));

    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    // The refusal prefix is what distinguishes "no access to the project" from a missing key.
    expect(res.body.message).toBe('projects.40003');
    await expect(
      db.roleBinding.count({ where: { projectId, principalType: 'USER', principalId: userIds.outsider as string } }),
    ).resolves.toBe(0);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-5 .. AC-6 — the agent roster is the items alone, and an agent row carries no roles
  // -------------------------------------------------------------------------

  it('AC-5: a Project Admin of P gets a roster whose only key is items', async () => {
    const res = await request(server).get(rosterUrl).set(auth('pa')).expect(200);

    expect(Object.keys(data<Record<string, unknown>>(res))).toEqual(['items']);
  }, TIMEOUT);

  it('AC-6: the one roster item carries no roles property', async () => {
    const res = await request(server).get(rosterUrl).set(auth('pa')).expect(200);
    const items = data<{ items: Array<Record<string, unknown>> }>(res).items;

    // The viewer-bound agent is P's only agent member, so the row under test is the whole roster.
    expect(items).toHaveLength(1);
    expect(items[0]?.slug).toBe('roster-bot');
    expect(items[0]).not.toHaveProperty('roles');
    // The rest of the row is untouched: the capabilities the agent was created with are still there.
    expect(items[0]?.capabilities).toEqual(['typescript']);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-7 .. AC-9 — every agent response is the profile without roles
  // -------------------------------------------------------------------------

  it('AC-7: the agent list a global admin reads has no roles property on any agent', async () => {
    const res = await request(server).get('/api/agents').set(auth('gadmin')).expect(200);
    const listed = data<Array<Record<string, unknown>>>(res);

    expect(listed.length).toBeGreaterThan(0);
    for (const agent of listed) expect(agent).not.toHaveProperty('roles');
  }, TIMEOUT);

  it("AC-8: an agent's own profile has no roles property", async () => {
    const res = await request(server)
      .get('/api/agents/me')
      .set({ Authorization: `Bearer ${agents.roster?.apiKey as string}` })
      .expect(200);

    const profile = data<Record<string, unknown>>(res);
    expect(profile.slug).toBe('roster-bot');
    expect(profile).not.toHaveProperty('roles');
  }, TIMEOUT);

  it('AC-9: a created agent is answered without a roles property', async () => {
    const res = await request(server)
      .post('/api/agents')
      .set(auth('gadmin'))
      .send({ name: 'No Roles Bot', slug: 'no-roles-bot', capabilities: ['nax'] });

    expect(res.status).toBe(201);
    const body = data<{ agent: Record<string, unknown>; apiKey: string }>(res);
    expect(body.agent.slug).toBe('no-roles-bot');
    expect(body.agent).not.toHaveProperty('roles');
    expect(body.agent.capabilities).toEqual([
      expect.objectContaining({ capability: 'nax' }),
    ]);
    expect(body.apiKey).toEqual(expect.any(String));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-10 — the added member carries its bindings, not a display role
  // -------------------------------------------------------------------------

  it('AC-10: an add with { email, roleKey: developer } answers a member with no role property', async () => {
    const res = await request(server)
      .post(membersUrl)
      .set(auth('pa'))
      .send({ email: 'addable@koda.test', roleKey: 'developer' })
      .expect(201);

    const added = data<MemberRow>(res);
    expect(added).not.toHaveProperty('role');
    expect(added.userId).toBe(userIds.addable);
    // The binding is what says which role was granted, with the string id of the row to edit.
    expect(added.bindings).toEqual([
      expect.objectContaining({ roleKey: 'developer', roleName: 'Developer', id: expect.any(String) }),
    ]);
  }, TIMEOUT);
});

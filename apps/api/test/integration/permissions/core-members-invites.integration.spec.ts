import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Permissions P1 US-008 — the member and invite routes check catalog keys instead of the
 * `resolveMembership`/`assertProjectAdmin` assertions inside `ProjectMembersService` and
 * `ProjectInvitesService` (AC-1 .. AC-13), over real HTTP + Postgres.
 *
 * One booted application for the whole file. The first registration is the installation's Owner, so
 * the fixtures (users, project, memberships, agent roster row) are built as that Owner; every
 * assertion below acts as a principal whose only source in `p1` is one role binding. A global admin is
 * a separate, explicitly created ADMIN user, so "global admin" is never confused with "Owner".
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/core-members-invites.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { MembershipService } from '../../../src/permissions/membership.service';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';
import { PermissionService } from '../../../src/permissions/permission.service';
import type { KodaPrincipal } from '../../../src/auth/principal/koda-principal.types';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

const P1_SLUG = 'p1';
const P1_KEY = 'PONE';
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

describeIntegration('member and invite route keys (US-008)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let membership: MembershipService;

  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};
  let p1Id = '';
  let agent: Agent;

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const membersUrl = `/api/projects/${P1_SLUG}/members`;
  const invitesUrl = `/api/projects/${P1_SLUG}/invites`;

  /** The refusal contract of one refused permission key: 403, code 40003, the exact sentence. */
  const expectPermissionsRefusal = (res: request.Response): void => {
    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(PERMISSIONS_REFUSED);
  };

  /**
   * Permissions P1l (US-005): the create route takes no role, so an account starts as a plain member.
   * Every caller below acts through a project binding or the global `member` baseline; the file no
   * longer needs a global admin (US-006 removed the AC-12 case that did).
   */
  const createUser = async (who: string): Promise<void> => {
    const created = await request(server)
      .post('/api/admin/users')
      .set(auth('root'))
      .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD })
      .expect(201);
    userIds[who] = data<{ id: string }>(created).id;
    resetThrottle(app);
    tokens[who] = await loginToken(server, `${who}@koda.test`);
  };

  /** The binding that is the caller's only source in p1. */
  const bind = (who: string, roleKey: RoleKey): Promise<unknown> =>
    withTestActor({ type: 'SYSTEM', id: 'seed' }, () => membership.createBinding(
      { principal: { type: 'USER', id: userIds[who] }, roleKey, projectId: p1Id },
      { type: 'SYSTEM', id: 'test' },
    ));

  /** The bindings the user holds in p1 — what "no binding created" and "unchanged" are measured against. */
  const bindingsFor = (who: string) =>
    db.roleBinding.findMany({
      where: { principalType: 'USER', principalId: userIds[who], projectId: p1Id },
      select: { id: true, role: { select: { key: true } } },
    });

  /** The member rows p1 lists, read through the route: what a refused write must not change. */
  const listedMembers = async (who: string): Promise<{ userId: string | null }[]> => {
    const res = await request(server).get(membersUrl).set(auth(who)).expect(200);
    return data<{ records: { userId: string | null }[] }>(res).records.map(({ userId }) => ({ userId }));
  };

  const memberBindingOf = (who: string) =>
    db.roleBinding.findFirst({ where: { projectId: p1Id, principalType: 'USER', principalId: userIds[who] } });

  const inviteRow = (id: string) =>
    db.projectInvite.findUniqueOrThrow({ where: { id }, select: { status: true } });

  /** A pending invite for an address with no account, created through the route as the Owner. */
  const pendingInviteId = async (email: string): Promise<string> => {
    const res = await request(server)
      .post(invitesUrl)
      .set(auth('root'))
      .send({ email, roleKey: 'viewer' })
      .expect(201);
    const id = data<{ invite?: { id: string } }>(res).invite?.id;
    if (!id) throw new Error('invite create answered no invite id');
    return id;
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    server = app.getHttpServer();
    db = fixtureDb(app);
    membership = app.get(MembershipService);

    const root = await request(server)
      .post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD })
      .expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;

    for (const who of ['developer', 'viewer', 'padmin', 'target', 'addable', 'removable']) await createUser(who);

    const project = await request(server)
      .post('/api/projects')
      .set(auth('root'))
      .send({ name: 'P1', slug: P1_SLUG, key: P1_KEY })
      .expect(201);
    p1Id = data<{ id: string }>(project).id;

    await bind('developer', 'developer');
    await bind('viewer', 'viewer');
    await bind('padmin', 'project-admin');

    // `removable` is a member before any test runs, so AC-3 and AC-4 mutate a row that exists rather
    // than depending on AC-2 having added one.
    await request(server)
      .post(membersUrl)
      .set(auth('root'))
      .send({ email: 'removable@koda.test', roleKey: 'viewer' })
      .expect(201);

    const createdAgent = await request(server)
      .post('/api/agents')
      .set(auth('root'))
      .send({ name: 'legacy-agent', slug: 'legacy-agent', roles: ['DEVELOPER'] })
      .expect(201);
    const payload = data<{ agent: { id: string; slug: string }; apiKey: string }>(createdAgent);
    agent = { ...payload.agent, apiKey: payload.apiKey };
    // AC-13: viewer reach lets the agent reach the permissions guard, which refuses member writes.
    await grantRole(db, { type: 'AGENT', id: agent.id }, 'viewer', p1Id);
  }, BOOT_TIMEOUT);

  afterAll(async () => {
    await app?.close();
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // AC-1 .. AC-2 — POST /projects/:slug/members needs member.add
  // -------------------------------------------------------------------------

  it('AC-1: a developer binding alone is refused by POST /projects/p1/members with 403 permissions and no binding', async () => {
    const res = await request(server)
      .post(membersUrl)
      .set(auth('developer'))
      .send({ email: 'target@koda.test' });

    expectPermissionsRefusal(res);
    await expect(bindingsFor('target')).resolves.toEqual([]);
    await expect(memberBindingOf('target')).resolves.toBeNull();
  }, TIMEOUT);

  it('AC-2: a project-admin binding alone adds a member with 201', async () => {
    const res = await request(server)
      .post(membersUrl)
      .set(auth('padmin'))
      .send({ email: 'addable@koda.test', roleKey: 'developer' })
      .expect(201);

    // Permissions P1l US-006: the added member answers its bindings, not a display role.
    const added = data<{ userId: string; bindings: { roleKey: string; id: string }[] }>(res);
    expect(added.userId).toBe(userIds.addable);
    expect(added).not.toHaveProperty('role');
    expect(added.bindings).toEqual([expect.objectContaining({ roleKey: 'developer' })]);
    await expect(bindingsFor('addable')).resolves.toEqual([
      expect.objectContaining({ role: { key: 'developer' } }),
    ]);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-3 .. AC-4 — a member's binding write needs role.binding.manage, on the role-bindings route
  //
  // Permissions P1 US-003 deleted the members PATCH and DELETE, and a member's role change or removal
  // is a binding write. These two cases keep the key they were written for: `role.binding.manage`
  // refused the developer, and the member's bindings did not change.
  // -------------------------------------------------------------------------

  it('AC-3: a developer binding alone is refused a binding write on /role-bindings with 403 permissions and the role is unchanged', async () => {
    const before = await bindingsFor('removable');

    const res = await request(server)
      .post('/api/role-bindings')
      .set(auth('developer'))
      .send({ principalType: 'USER', principalId: userIds.removable, roleKey: 'developer', projectId: p1Id });

    expectPermissionsRefusal(res);
    await expect(bindingsFor('removable')).resolves.toEqual(before);
  }, TIMEOUT);

  it('AC-4: a developer binding alone is refused a binding delete on /role-bindings with 403 permissions and the member stays', async () => {
    const before = await bindingsFor('removable');
    const listedBefore = await listedMembers('padmin');
    const [binding] = before;
    if (!binding) throw new Error('removable holds no binding to revoke');

    const res = await request(server)
      .delete(`/api/role-bindings/${binding.id}`)
      .set(auth('developer'));

    expectPermissionsRefusal(res);
    await expect(bindingsFor('removable')).resolves.toEqual(before);
    await expect(listedMembers('padmin')).resolves.toEqual(listedBefore);
    expect(listedBefore).toContainEqual({ userId: userIds.removable });
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-5 .. AC-6 — GET /projects/:slug/members needs member.read, and answers the page alone
  //
  // Permissions P1l US-006: the page carries no `canManage` and no `viewerRole`. What these cases keep
  // is the key they were written for — a viewer binding and a project-admin binding both list the
  // members — and AC-12 (`a global admin with no source lists them`) moved to the me-permissions route.
  // -------------------------------------------------------------------------

  /** The six fields a member page carries, and no other. */
  const MEMBER_PAGE_FIELDS = ['current', 'hasNext', 'hasPrev', 'records', 'size', 'total'];

  it('AC-5: a viewer binding alone lists the members with 200 and no management fields', async () => {
    const res = await request(server).get(membersUrl).set(auth('viewer')).expect(200);

    const body = data<Record<string, unknown>>(res);
    expect(Object.keys(body).sort()).toEqual(MEMBER_PAGE_FIELDS);
  }, TIMEOUT);

  it('AC-6: a project-admin binding alone lists the members with 200 and no management fields', async () => {
    const res = await request(server).get(membersUrl).set(auth('padmin')).expect(200);

    const body = data<Record<string, unknown>>(res);
    expect(Object.keys(body).sort()).toEqual(MEMBER_PAGE_FIELDS);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-7 .. AC-9 — GET/POST /projects/:slug/invites need invite.read / invite.create
  // -------------------------------------------------------------------------

  it('AC-7: a developer binding alone is refused by GET /projects/p1/invites with 403 permissions', async () => {
    const res = await request(server).get(invitesUrl).set(auth('developer'));

    expectPermissionsRefusal(res);
  }, TIMEOUT);

  it('AC-8: a project-admin binding alone lists the invites with 200', async () => {
    const res = await request(server).get(invitesUrl).set(auth('padmin')).expect(200);

    expect(Array.isArray(data<unknown[]>(res))).toBe(true);
  }, TIMEOUT);

  it('AC-9: a project-admin binding alone invites an address with no account, 201', async () => {
    const res = await request(server)
      .post(invitesUrl)
      .set(auth('padmin'))
      .send({ email: 'no-account@koda.test', roleKey: 'viewer' })
      .expect(201);

    const body = data<{ outcome: string; invite?: { id: string; email: string; status: string } }>(res);
    expect(body.outcome).toBe('INVITED');
    expect(body.invite).toMatchObject({ email: 'no-account@koda.test', status: 'PENDING' });
    expect(await db.user.count({ where: { email: 'no-account@koda.test' } })).toBe(0);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-10 .. AC-11 — POST …/:id/resend and DELETE …/:id need invite.resend / invite.cancel
  // -------------------------------------------------------------------------

  it('AC-10: a developer binding alone is refused by POST /projects/p1/invites/<id>/resend with 403 permissions, and the invite stays pending', async () => {
    const id = await pendingInviteId('resend-refused@koda.test');
    const before = await inviteRow(id);

    const res = await request(server)
      .post(`${invitesUrl}/${id}/resend`)
      .set(auth('developer'));

    expectPermissionsRefusal(res);
    await expect(inviteRow(id)).resolves.toEqual(before);
    expect(before.status).toBe('PENDING');
  }, TIMEOUT);

  it('AC-11: a developer binding alone is refused by DELETE /projects/p1/invites/<id> with 403 permissions, and the invite stays pending', async () => {
    const id = await pendingInviteId('cancel-refused@koda.test');
    const before = await inviteRow(id);

    const res = await request(server).delete(`${invitesUrl}/${id}`).set(auth('developer'));

    expectPermissionsRefusal(res);
    await expect(inviteRow(id)).resolves.toEqual(before);
    expect(before.status).toBe('PENDING');
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-13 — an agent's legacy roster row grants no member.add
  // -------------------------------------------------------------------------

  it('AC-13: an agent with a legacy AgentProject row in p1 is refused by POST /projects/p1/members with 403 permissions', async () => {
    const res = await request(server)
      .post(membersUrl)
      .set({ Authorization: `Bearer ${agent.apiKey}` })
      .send({ email: 'target@koda.test' });

    expectPermissionsRefusal(res);
    await expect(bindingsFor('target')).resolves.toEqual([]);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // B4 (whole-branch review) — a project-admin agent may invite
  // -------------------------------------------------------------------------

  it('B4: an agent with a project-admin binding invites an unknown address with 201, and is named as the inviter', async () => {
    await withTestActor({ type: 'SYSTEM', id: 'seed' }, () => membership.createBinding(
      { principal: { type: 'AGENT', id: agent.id }, roleKey: 'project-admin', projectId: p1Id },
      { type: 'SYSTEM', id: 'test' },
    ));

    const created = await request(server)
      .post(invitesUrl)
      .set({ Authorization: `Bearer ${agent.apiKey}` })
      .send({ email: 'agent-invited@koda.test', roleKey: 'viewer' })
      .expect(201);

    const body = data<{ outcome: string; invite?: { id: string; email: string; status: string; inviterName: string | null } }>(created);
    expect(body.outcome).toBe('INVITED');
    expect(body.invite).toMatchObject({
      email: 'agent-invited@koda.test',
      status: 'PENDING',
      inviterName: 'legacy-agent',
    });

    // The inviter goes in the agent column; `invitedById` — a required foreign key to `User` before this
    // fix, which is what made this permitted operation a P2003 — stays null.
    const row = await db.projectInvite.findUniqueOrThrow({
      where: { id: body.invite?.id ?? '' },
      select: { invitedById: true, invitedByAgentId: true },
    });
    expect(row).toEqual({ invitedById: null, invitedByAgentId: agent.id });

    // The listing resolves the same name from the agent id, without a relation to join.
    const listed = await request(server).get(invitesUrl).set(auth('padmin')).expect(200);
    expect(data<{ email: string; inviterName: string | null }[]>(listed)).toContainEqual(
      expect.objectContaining({ email: 'agent-invited@koda.test', inviterName: 'legacy-agent' }),
    );
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // B2 (whole-branch review) — a binding member removal invalidates the cache
  // -------------------------------------------------------------------------
  it('B2: revoking a member\'s developer binding ends its warmed project keys', async () => {
    await createUser('legacymember');
    const binding = await grantRole(db, { type: 'USER', id: userIds.legacymember }, 'developer', p1Id);
    await membership.invalidatePermissions();
    const permissions = app.get(PermissionService);
    const principal = {
      actorType: 'user',
      id: userIds.legacymember,
      role: 'MEMBER',
      email: 'legacymember@koda.test',
    } as KodaPrincipal;
    await expect(permissions.can(principal, 'ticket.create', { projectId: p1Id })).resolves.toEqual(
      expect.objectContaining({ allowed: true }),
    );

    // The DELETE route's own service call: no explicit invalidation follows it here.
    await request(server).delete(`/api/role-bindings/${binding.id}`).set(auth('padmin')).expect(204);

    await expect(bindingsFor('legacymember')).resolves.toEqual([]);
    await expect(permissions.can(principal, 'ticket.create', { projectId: p1Id })).resolves.toEqual(
      expect.objectContaining({ allowed: false }),
    );
  }, TIMEOUT);
});

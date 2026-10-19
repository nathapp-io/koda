/**
 * Permissions P1 US-010 — the admin users, outbox and SLO routes check their global catalog keys,
 * and the auth, home, `/me` notification and public invite routes declare theirs (public keys with no
 * principal, implicit keys for any authenticated principal) while keeping their principal-type
 * rules (AC-1 .. AC-17), over real HTTP + Postgres.
 *
 * One booted application for the whole file. The first registration is the installation's Owner, so
 * the fixtures (users, project, agent, invite) are built as that Owner; `gadmin` is a separate,
 * explicitly created ADMIN user, so "global admin" is never confused with "Owner".
 *
 * The logins (5/min) and the agent create (10/min) would throttle a file this long, so the counters
 * are dropped after every one of them: the throttle is not what these ACs are about.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/core-admin-public-implicit.integration.spec.ts
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
const TIMEOUT = 30_000;
const BOOT_TIMEOUT = 60_000;

const readI18n = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(__dirname, `../../../src/i18n/en/${file}.json`), 'utf8')) as Record<string, unknown>;

const sentence = (file: string, key: string): string => readI18n(file)[key] as string;
const nestedSentence = (file: string, outer: string, inner: string): string =>
  (readI18n(file)[outer] as Record<string, string>)[inner];

/** `permissions.40003`, the sentence every refused permission key carries. */
const PERMISSIONS_REFUSED = sentence('permissions', '40003');
/** `users.self.40003`, the sentence the self-demotion refusal carries. */
const USERS_SELF_REFUSED = nestedSentence('users', 'self', '40003');
/** `notifications.40003`, the sentence the users-only inbox refusal carries. */
const NOTIFICATIONS_REFUSED = sentence('notifications', '40003');
/** `auth.40000`, the sentence the handler-level auth refusal carries. */
const AUTH_REFUSED = sentence('auth', '40000');

interface AgentFixture {
  id: string;
  slug: string;
  apiKey: string;
}

describeIntegration('admin, auth, home, notification and public invite route keys (US-010)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let membership: MembershipService;

  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};
  let p1Id = '';
  let agent: AgentFixture;
  let inviteToken = '';

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

  /** The refusal contract of one refused permission key: 403, code 40003, the exact sentence. */
  const expectPermissionsRefusal = (res: request.Response): void => {
    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(PERMISSIONS_REFUSED);
  };

  const createUser = async (who: string, role: 'MEMBER' | 'ADMIN' = 'MEMBER'): Promise<void> => {
    const created = await request(server)
      .post('/api/admin/users')
      .set(auth('root'))
      .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role })
      .expect(201);
    userIds[who] = data<{ id: string }>(created).id;
    resetThrottle(app);
    tokens[who] = await loginToken(server, `${who}@koda.test`);
    resetThrottle(app);
  };

  const bindingsOf = (who: string) =>
    db.roleBinding.count({ where: { principalType: 'USER', principalId: userIds[who] } });

  const roleOf = async (who: string): Promise<string> =>
    (await db.user.findUniqueOrThrow({ where: { id: userIds[who] }, select: { role: true } })).role;

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

    // `member` holds nothing but the baseline; `gadmin` is the installation's other global admin;
    // `target` is what a refused PATCH must leave alone.
    for (const who of ['member', 'plain', 'target']) await createUser(who);
    await createUser('gadmin', 'ADMIN');

    // AC-13, AC-14 and AC-17's caller holds *no* binding row at all: the baseline `member` binding
    // the admin route writes is removed here, so the 200s cannot come from a role.
    await db.roleBinding.deleteMany({ where: { principalType: 'USER', principalId: userIds.plain } });
    await membership.invalidatePermissions();

    const project = await request(server)
      .post('/api/projects')
      .set(auth('root'))
      .send({ name: 'P1', slug: P1_SLUG, key: P1_KEY })
      .expect(201);
    p1Id = data<{ id: string }>(project).id;

    const createdAgent = await request(server)
      .post('/api/agents')
      .set(auth('root'))
      .send({ name: 'koda-agent', slug: 'koda-agent' })
      .expect(201);
    const payload = data<{ agent: { id: string; slug: string }; apiKey: string }>(createdAgent);
    agent = { ...payload.agent, apiKey: payload.apiKey };
    resetThrottle(app);

    // AC-12: a pending invite whose raw token the create response hands back in `invitePath`.
    const invite = await request(server)
      .post(`/api/projects/${P1_SLUG}/invites`)
      .set(auth('root'))
      .send({ email: 'invited@koda.test', role: 'VIEWER' })
      .expect(201);
    const inviteBody = data<{ outcome: string; invitePath?: string }>(invite);
    expect(inviteBody.outcome).toBe('INVITED');
    inviteToken = (inviteBody.invitePath ?? '').split('/').pop() ?? '';
    expect(inviteToken).not.toBe('');
  }, BOOT_TIMEOUT);

  afterAll(async () => {
    await app?.close();
  });

  // -------------------------------------------------------------------------
  // AC-1 .. AC-5 — the admin user routes need user.read / user.create / user.update
  // -------------------------------------------------------------------------

  it('AC-1: a MEMBER gets 403 permissions from GET /admin/users', async () => {
    const res = await request(server).get('/api/admin/users').set(auth('member'));

    expectPermissionsRefusal(res);
  }, TIMEOUT);

  it('AC-2: a MEMBER gets 403 permissions from POST /admin/users and no user is created', async () => {
    const res = await request(server)
      .post('/api/admin/users')
      .set(auth('member'))
      .send({ email: 'refused@koda.test', name: 'Refused', password: TEST_PASSWORD, role: 'MEMBER' });

    expectPermissionsRefusal(res);
    await expect(db.user.count({ where: { email: 'refused@koda.test' } })).resolves.toBe(0);
  }, TIMEOUT);

  it('AC-3: a MEMBER gets 403 permissions from PATCH /admin/users/<id> and the role is unchanged', async () => {
    const before = await roleOf('target');

    const res = await request(server)
      .patch(`/api/admin/users/${userIds.target}`)
      .set(auth('member'))
      .send({ role: 'ADMIN' });

    expectPermissionsRefusal(res);
    await expect(roleOf('target')).resolves.toBe(before);
    expect(before).toBe('MEMBER');
  }, TIMEOUT);

  it('AC-4: a global admin gets 200 from GET /admin/users', async () => {
    const res = await request(server).get('/api/admin/users').set(auth('gadmin')).expect(200);

    const page = data<{ total: number; records: { id: string }[] }>(res);
    expect(page.total).toBeGreaterThan(0);
    expect(page.records.map(({ id }) => id)).toContain(userIds.member);
  }, TIMEOUT);

  it('AC-5: a global admin gets 403 users.self from PATCH /admin/users/<own id> with { role: MEMBER }', async () => {
    const res = await request(server)
      .patch(`/api/admin/users/${userIds.gadmin}`)
      .set(auth('gadmin'))
      .send({ role: 'MEMBER' });

    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(USERS_SELF_REFUSED);
    await expect(roleOf('gadmin')).resolves.toBe('ADMIN');
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-6 .. AC-8 — the outbox routes need outbox.read / outbox.retry
  // -------------------------------------------------------------------------

  it('AC-6: a MEMBER gets 403 permissions from GET /admin/outbox', async () => {
    const res = await request(server).get('/api/admin/outbox').set(auth('member'));

    expectPermissionsRefusal(res);
  }, TIMEOUT);

  it('AC-7: a MEMBER gets 403 permissions from POST /admin/outbox/<event id>/retry before any lookup', async () => {
    // The id names no row: a caller that got past the guard would be answered 404, not 403.
    const eventId = 'no-such-event';

    const refused = await request(server)
      .post(`/api/admin/outbox/${eventId}/retry`)
      .set(auth('member'));

    expectPermissionsRefusal(refused);

    const admin = await request(server).post(`/api/admin/outbox/${eventId}/retry`).set(auth('gadmin'));
    expect(admin.status).toBe(404);
    expect(admin.body.ret).toBe(404);
  }, TIMEOUT);

  it('AC-8: a global admin gets 200 from GET /admin/outbox', async () => {
    const res = await request(server).get('/api/admin/outbox').set(auth('gadmin')).expect(200);

    expect(res.body).toEqual(
      expect.objectContaining({ items: expect.any(Array), total: expect.any(Number) }),
    );
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-9 .. AC-10 — the SLO route needs admin.slo.read
  // -------------------------------------------------------------------------

  it('AC-9: a MEMBER gets 403 permissions from GET /admin/slos', async () => {
    const res = await request(server).get('/api/admin/slos').set(auth('member'));

    expectPermissionsRefusal(res);
  }, TIMEOUT);

  it('AC-10: a global admin gets 200 from GET /admin/slos', async () => {
    const res = await request(server).get('/api/admin/slos').set(auth('gadmin')).expect(200);

    const metrics = data<{ retrievalLatency: { sampleCount: number } }>(res);
    expect(metrics.retrievalLatency.sampleCount).toBeGreaterThanOrEqual(0);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-11 .. AC-12 — the public keys need no principal
  // -------------------------------------------------------------------------

  it('AC-11: POST /auth/login with valid credentials and no token answers 200', async () => {
    const res = await request(server)
      .post('/api/auth/login')
      .send({ email: 'member@koda.test', password: TEST_PASSWORD })
      .expect(200);

    expect(data<{ accessToken: string }>(res).accessToken).toEqual(expect.any(String));
    resetThrottle(app);
  }, TIMEOUT);

  it('AC-12: GET /invites/<token> of a pending invite with no token answers 200', async () => {
    const res = await request(server).get(`/api/invites/${inviteToken}`).expect(200);

    const preview = data<{ projectSlug: string; email: string; role: string }>(res);
    expect(preview).toMatchObject({ projectSlug: P1_SLUG, email: 'invited@koda.test', role: 'VIEWER' });
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-13 .. AC-14 — the implicit keys need an authenticated principal and nothing else
  // -------------------------------------------------------------------------

  it('AC-13: a user with no binding gets 200 from GET /home', async () => {
    await expect(bindingsOf('plain')).resolves.toBe(0);

    const res = await request(server).get('/api/home').set(auth('plain')).expect(200);

    expect(data<{ projects: unknown[] }>(res).projects).toEqual(expect.any(Array));
  }, TIMEOUT);

  it('AC-14: a user with no binding gets 200 from GET /auth/me', async () => {
    await expect(bindingsOf('plain')).resolves.toBe(0);

    const res = await request(server).get('/api/auth/me').set(auth('plain')).expect(200);

    expect(data<{ email: string }>(res).email).toBe('plain@koda.test');
  }, TIMEOUT);

  it('AC-15: an agent gets 401 auth from GET /auth/me', async () => {
    const res = await request(server)
      .get('/api/auth/me')
      .set({ Authorization: `Bearer ${agent.apiKey}` });

    expect(res.status).toBe(401);
    expect(res.body.ret).toBe(40000);
    expect(res.body.message).toBe(AUTH_REFUSED);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-16 — the inbox still refuses agents
  // -------------------------------------------------------------------------

  it('AC-16: an agent gets 403 notifications from GET /me/notifications', async () => {
    const res = await request(server)
      .get('/api/me/notifications')
      .set({ Authorization: `Bearer ${agent.apiKey}` });

    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(NOTIFICATIONS_REFUSED);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-17 — the preference route needs an authenticated principal and a valid body
  // -------------------------------------------------------------------------

  it('AC-17: a user with no binding gets 200 from PUT /me/notification-preferences', async () => {
    await expect(bindingsOf('plain')).resolves.toBe(0);

    const res = await request(server)
      .put('/api/me/notification-preferences')
      .set(auth('plain'))
      .send({ emailEnabled: false, items: [{ category: 'ASSIGNED', email: false }] })
      .expect(200);

    const view = data<{ emailEnabled: boolean; items: { category: string; email: boolean }[] }>(res);
    expect(view.emailEnabled).toBe(false);
    expect(view.items).toContainEqual(expect.objectContaining({ category: 'ASSIGNED', email: false }));
  }, TIMEOUT);
});

/**
 * US-005 — public invite preview, accept, resend and cancel over real Postgres.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/projects/project-invites-public
 *
 * Booted with registration disabled (the first register still succeeds against an
 * empty table, as in admin-users.integration.spec.ts). Email is off because
 * SMTP_URL is unset, so no invite mail leaves the process.
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { DefaultThrottlerGuard } from '@nathapp/nestjs-throttler';
import { IS_PUBLIC_KEY } from '@nathapp/nestjs-auth';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

interface InviteDto {
  id: string;
  email: string;
  role: string;
  status: string;
  inviterName: string | null;
  expiresAt: string;
  createdAt: string;
}

interface InviteCreateResult {
  outcome: string;
  invite?: InviteDto;
  invitePath?: string;
  emailed?: boolean;
}

interface PreviewDto {
  projectName: string;
  projectSlug: string;
  email: string;
  role: string;
  inviterName: string | null;
  expiresAt: string;
}

interface SessionDto {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; role: string };
}

const unique = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const tokenFrom = (invitePath: string | undefined): string => (invitePath ?? '').split('/').pop() ?? '';
/** Project keys are `^[A-Z]{2,6}$` (letters only). */
const randomKey = (): string =>
  Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

/**
 * Loads a module US-005 introduces. Until it lands `require` throws; returning
 * undefined lets the assertion fire first, so the RED failure is an assertion
 * rather than a module-resolution crash.
 */
const loadModule = <T>(path: string): T | undefined => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(path) as T;
  } catch {
    return undefined;
  }
};

/** 5/min is the documented default; the real value comes from auth-throttle once US-005 lands. */
const DEFAULT_AUTH_LOGIN_LIMIT = 5;
const authLoginLimit = (): number =>
  loadModule<{ AUTH_LOGIN_LIMIT: number }>('../../../src/auth/auth-throttle')?.AUTH_LOGIN_LIMIT ??
  DEFAULT_AUTH_LOGIN_LIMIT;

describeIntegration('US-005 public invite preview, accept, resend and cancel (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaService<PrismaClient>;
  let rootToken: string;

  const auth = (token: string = rootToken) => ({ Authorization: `Bearer ${token}` });
  const post = (path: string, body: object, token: string = rootToken) =>
    request(server).post(`/api${path}`).set(auth(token)).send(body);
  const get = (path: string, token: string = rootToken) =>
    request(server).get(`/api${path}`).set(auth(token));
  const preview = (token: string) => request(server).get(`/api/invites/${token}`);
  const accept = (token: string, body: { name: string; password: string } = { name: 'New User', password: TEST_PASSWORD }) =>
    request(server).post(`/api/invites/${token}/accept`).send(body);

  const inviteRow = (id: string) => prisma.client.projectInvite.findUniqueOrThrow({ where: { id } });

  const freshInvite = async (email: string = `${unique()}@example.com`, role = 'DEVELOPER') => {
    const res = await post('/projects/s4b/invites', { email, role }).expect(201);
    const body = data<InviteCreateResult>(res);
    expect(body.outcome).toBe('INVITED');
    expect(body.invite).toBeDefined();
    const token = tokenFrom(body.invitePath);
    return { body, token, row: await inviteRow(body.invite?.id ?? '') };
  };

  // The global DefaultThrottlerGuard keeps hit counters in memory; the acceptance
  // suite makes more login/accept calls than AUTH_LOGIN_LIMIT within 60 s, so clear
  // the counters between tests (same approach as admin-users.integration.spec.ts).
  let resetThrottle: () => void;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService);

    const guard = app.get(DefaultThrottlerGuard);
    const storageService = (guard as unknown as {
      storageService: {
        storage: Map<string, unknown>;
        timeoutIds?: Map<string, NodeJS.Timeout[]>;
        hitExpirations?: Map<string, unknown>;
      };
    }).storageService;
    resetThrottle = () => {
      storageService.timeoutIds?.forEach((timeouts) => timeouts.forEach(clearTimeout));
      storageService.timeoutIds?.clear();
      storageService.hitExpirations?.clear();
      storageService.storage.clear();
    };

    const res = await request(server).post('/api/auth/register')
      .send({ email: 's5-root@koda.test', name: 'S5 Root', password: TEST_PASSWORD }).expect(201);
    rootToken = data<SessionDto>(res).accessToken;

    await post('/projects', { name: 'S5 Project', slug: 's4b', key: 'SPV' }).expect(201);
  });

  beforeEach(() => {
    resetThrottle();
  });

  afterAll(async () => {
    await app.close();
  });

  // ── US-005 AC-1 ───────────────────────────────────────────────────────────
  it('US-005 AC-1: previews a pending invite with exactly the six public fields', async () => {
    const { token, row } = await freshInvite();

    const res = await preview(token);
    expect(res.status).toBe(200);
    const view = data<PreviewDto>(res);

    expect(Object.keys(view).sort()).toEqual(
      ['projectName', 'projectSlug', 'email', 'role', 'inviterName', 'expiresAt'].sort(),
    );
    expect(view).toMatchObject({
      projectName: 'S5 Project',
      projectSlug: 's4b',
      email: row.email,
      role: 'DEVELOPER',
      inviterName: 'S5 Root',
    });
    expect(new Date(view.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('US-005 AC-1: previews an invite role that differs from the default', async () => {
    const { token, row } = await freshInvite(`${unique()}@example.com`, 'VIEWER');

    const view = data<PreviewDto>(await preview(token).expect(200));

    expect(view.role).toBe('VIEWER');
    expect(view.email).toBe(row.email);
  });

  // ── US-005 AC-2 ───────────────────────────────────────────────────────────
  it('US-005 AC-2: unknown, expired and cancelled tokens produce byte-identical 404 responses', async () => {
    const expired = await freshInvite();
    await prisma.client.projectInvite.update({
      where: { id: expired.row.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const cancelled = await freshInvite();
    await prisma.client.projectInvite.update({
      where: { id: cancelled.row.id },
      data: { status: 'CANCELLED' },
    });

    const [unknown, expiredRes, cancelledRes] = await Promise.all([
      preview('definitely-not-a-real-token'),
      preview(expired.token),
      preview(cancelled.token),
    ]);

    expect([unknown.status, expiredRes.status, cancelledRes.status]).toEqual([404, 404, 404]);
    expect(expiredRes.text).toBe(unknown.text);
    expect(cancelledRes.text).toBe(unknown.text);
  });

  // ── US-005 AC-3 ───────────────────────────────────────────────────────────
  it('US-005 AC-3: accept creates one MEMBER account for the invite email with a bcrypt-verifiable password', async () => {
    const { token, row } = await freshInvite();

    const res = await accept(token);
    expect(res.status).toBe(201);
    const body = data<SessionDto>(res);
    expect(body.user.email.toLowerCase()).toBe(row.email);

    const users = await prisma.client.user.findMany({
      where: { email: { equals: row.email, mode: 'insensitive' } },
    });
    expect(users).toHaveLength(1);
    expect(users[0].role).toBe('MEMBER');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    expect(await require('bcrypt').compare(TEST_PASSWORD, users[0].passwordHash)).toBe(true);
  });

  it('US-005 AC-3: replaying an accepted token creates no second account', async () => {
    const { token, row } = await freshInvite();
    await accept(token).expect(201);

    expect((await accept(token)).status).toBe(404);
    expect(await prisma.client.user.count({ where: { email: { equals: row.email, mode: 'insensitive' } } })).toBe(1);
  });

  // ── US-005 AC-4 ───────────────────────────────────────────────────────────
  it('US-005 AC-4: accept creates a ProjectMember for the new user with the invite role', async () => {
    const { token, row } = await freshInvite(`${unique()}@example.com`, 'VIEWER');

    await accept(token).expect(201);
    const accepted = await inviteRow(row.id);
    expect(accepted.status).toBe('ACCEPTED');
    expect(accepted.acceptedByUserId).toEqual(expect.any(String));

    const membership = await prisma.client.projectMember.findFirstOrThrow({
      where: { projectId: row.projectId, userId: accepted.acceptedByUserId ?? '' },
    });
    expect(membership.role).toBe('VIEWER');
  });

  it('US-005 AC-4: no membership is written when acceptance is rejected', async () => {
    const { token, row } = await freshInvite();
    await prisma.client.user.create({
      data: { email: row.email, name: 'Taken', passwordHash: 'x', role: 'MEMBER' },
    });

    expect((await accept(token)).status).toBe(409);
    expect(await prisma.client.projectMember.count({
      where: { projectId: row.projectId, user: { email: { equals: row.email, mode: 'insensitive' } } },
    })).toBe(0);
  });

  // ── US-005 AC-5 ───────────────────────────────────────────────────────────
  it('US-005 AC-5: the returned access token authorises GET /projects/:slug for the invite project', async () => {
    const { token } = await freshInvite();
    const body = data<SessionDto>(await accept(token).expect(201));

    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.refreshToken).toEqual(expect.any(String));
    await get('/projects/s4b', body.accessToken).expect(200);
  });

  it('US-005 AC-5: the new token does not authorise a project the member was not invited to', async () => {
    await post('/projects', { name: 'Other', slug: `other-${unique()}`, key: randomKey() })
      .expect(201);
    const otherSlug = (await prisma.client.project.findFirstOrThrow({ where: { name: 'Other' } })).slug;

    const { token } = await freshInvite();
    const body = data<SessionDto>(await accept(token).expect(201));

    expect((await get(`/projects/${otherSlug}`, body.accessToken)).status).toBe(403);
  });

  // ── US-005 AC-6 ───────────────────────────────────────────────────────────
  it('US-005 AC-6: an expired token responds 404 and writes nothing', async () => {
    const expired = await freshInvite();
    const live = await freshInvite();
    await prisma.client.projectInvite.update({
      where: { id: expired.row.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    // Positive control: a live token still previews, so the 404 below is expiry, not a missing route.
    expect((await preview(live.token)).status).toBe(200);
    expect((await accept(expired.token)).status).toBe(404);
    expect(await prisma.client.user.count({ where: { email: expired.row.email } })).toBe(0);
    expect((await inviteRow(expired.row.id)).status).toBe('PENDING');
    expect(await prisma.client.projectMember.count({ where: { projectId: expired.row.projectId } })).toBe(0);
  });

  // ── US-005 AC-7 ───────────────────────────────────────────────────────────
  it('US-005 AC-7: two concurrent accepts of the same token yield exactly one 201', async () => {
    const { token, row } = await freshInvite();

    const results = await Promise.all([accept(token), accept(token)]);
    const statuses = results.map((r) => r.status);

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 404)).toHaveLength(1);

    const users = await prisma.client.user.findMany({
      where: { email: { equals: row.email, mode: 'insensitive' } },
    });
    expect(users).toHaveLength(1);
    expect(await prisma.client.projectMember.count({ where: { projectId: row.projectId, userId: users[0].id } })).toBe(1);
    expect((await inviteRow(row.id)).status).toBe('ACCEPTED');
  });

  // ── US-005 AC-8 ───────────────────────────────────────────────────────────
  it('US-005 AC-8: resending rotates the token so the previous token responds 404', async () => {
    const { token, row } = await freshInvite();

    const res = await post(`/projects/s4b/invites/${row.id}/resend`, {}).expect(200);
    const next = tokenFrom(data<{ invitePath: string }>(res).invitePath);

    expect(next).not.toBe(token);
    expect(await prisma.client.projectInvite.findUniqueOrThrow({ where: { id: row.id } }))
      .toMatchObject({ status: 'PENDING' });
    expect((await accept(token)).status).toBe(404);
  });

  // ── US-005 AC-9 ───────────────────────────────────────────────────────────
  it('US-005 AC-9: an account created after the invite makes accept respond 409', async () => {
    const { token, row } = await freshInvite(`taken-${unique()}@example.com`);
    const created = await post('/admin/users', {
      email: row.email.toUpperCase(), name: 'Taken', password: TEST_PASSWORD, role: 'MEMBER',
    }).expect(201);
    const newUserId = data<{ id: string }>(created).id;

    expect((await accept(token)).status).toBe(409);
    expect(await prisma.client.user.count({ where: { email: { equals: row.email, mode: 'insensitive' } } })).toBe(1);
    expect(await prisma.client.projectMember.count({ where: { projectId: row.projectId, userId: newUserId } })).toBe(0);
    expect((await inviteRow(row.id)).status).toBe('PENDING');
  });

  // ── US-005 AC-10 ──────────────────────────────────────────────────────────
  it('US-005 AC-10: resending an invite id from another project responds 404 and leaves the row unchanged', async () => {
    const otherSlug = `other-${unique()}`;
    await post('/projects', { name: 'Other S5', slug: otherSlug, key: randomKey() }).expect(201);
    const otherInvite = await post(`/projects/${otherSlug}/invites`, { email: `${unique()}@example.com`, role: 'DEVELOPER' })
      .expect(201);
    const otherResult = data<InviteCreateResult>(otherInvite);
    const id = otherResult.invite?.id ?? '';
    const before = await inviteRow(id);

    expect((await post(`/projects/s4b/invites/${id}/resend`, {})).status).toBe(404);

    const after = await inviteRow(id);
    expect(after).toMatchObject({ tokenHash: before.tokenHash, status: before.status, expiresAt: before.expiresAt });

    // Positive control: the owning project can resend the same id, so the 404 above is the wrong project, not a missing route.
    expect((await post(`/projects/${otherSlug}/invites/${id}/resend`, {})).status).toBe(200);
    expect((await inviteRow(id)).tokenHash).not.toBe(before.tokenHash);
  });

  // ── US-005 AC-11 ──────────────────────────────────────────────────────────
  it("US-005 AC-11: password 'short' is rejected with 400 before any writes", async () => {
    const { token, row } = await freshInvite();

    expect((await accept(token, { name: 'Valid Name', password: 'short' })).status).toBe(400);
    expect(await prisma.client.user.count({ where: { email: row.email } })).toBe(0);
    expect((await inviteRow(row.id)).status).toBe('PENDING');
  });

  // ── US-005 AC-12 ──────────────────────────────────────────────────────────
  it('US-005 AC-12: resending an ACCEPTED invite responds 409 and leaves the row unchanged', async () => {
    const { token, row } = await freshInvite();
    await accept(token).expect(201);
    const before = await inviteRow(row.id);
    expect(before.status).toBe('ACCEPTED');

    expect((await post(`/projects/s4b/invites/${row.id}/resend`, {})).status).toBe(409);

    const after = await inviteRow(row.id);
    expect(after).toMatchObject({ tokenHash: before.tokenHash, status: before.status, expiresAt: before.expiresAt });
  });

  // ── US-005 AC-13 ──────────────────────────────────────────────────────────
  it('US-005 AC-13: cancelling a PENDING invite sets its status to CANCELLED', async () => {
    const { row } = await freshInvite();

    const res = await request(server).delete(`/api/projects/s4b/invites/${row.id}`).set(auth());
    expect([200, 204]).toContain(res.status);

    expect((await inviteRow(row.id)).status).toBe('CANCELLED');
  });

  it('US-005 AC-13: cancelling a final invite responds 409 and does not change the stored status', async () => {
    const { row } = await freshInvite();
    await request(server).delete(`/api/projects/s4b/invites/${row.id}`).set(auth()).expect(200);
    expect((await inviteRow(row.id)).status).toBe('CANCELLED');

    const res = await request(server).delete(`/api/projects/s4b/invites/${row.id}`).set(auth());
    expect(res.status).toBe(409);
    expect((await inviteRow(row.id)).status).toBe('CANCELLED');
  });

  // ── US-005 AC-14 ──────────────────────────────────────────────────────────
  it('US-005 AC-14: resending an expired invite returns a fresh token that accepts with 201', async () => {
    const { row } = await freshInvite();
    await prisma.client.projectInvite.update({
      where: { id: row.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const start = Date.now();

    const res = await post(`/projects/s4b/invites/${row.id}/resend`, {}).expect(200);
    const body = data<{ invitePath: string }>(res);
    expect(body.invitePath).toEqual(expect.any(String));

    const updated = await inviteRow(row.id);
    expect(updated.status).toBe('PENDING');
    expect(updated.expiresAt.getTime()).toBeGreaterThan(start);

    const accepted = await accept(tokenFrom(body.invitePath));
    expect(accepted.status).toBe(201);
    await get('/projects/s4b', data<SessionDto>(accepted).accessToken).expect(200);
  });

  // ── US-005 AC-15 ──────────────────────────────────────────────────────────
  it('US-005 AC-15: preview and accept are @Public and carry register\'s AUTH_LOGIN_LIMIT/60000 throttle', () => {
    const LIMIT_KEY = 'THROTTLER:LIMITdefault';
    const TTL_KEY = 'THROTTLER:TTLdefault';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const authModule = loadModule<{ AuthController: { prototype: Record<string, unknown> } }>(
      '../../../src/auth/auth.controller',
    );
    const invitesModule = loadModule<{ PublicInvitesController: { prototype: Record<string, unknown> } }>(
      '../../../src/projects/invites/public-invites.controller',
    );

    expect(invitesModule).toBeDefined();
    expect(authModule).toBeDefined();
    if (!invitesModule || !authModule) return;

    const register = authModule.AuthController.prototype['register'] as object;
    const previewFn = invitesModule.PublicInvitesController.prototype['preview'] as object;
    const acceptFn = invitesModule.PublicInvitesController.prototype['accept'] as object;

    for (const handler of [previewFn, acceptFn]) {
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true);
      expect(Reflect.getMetadata(LIMIT_KEY, handler)).toBe(authLoginLimit());
      expect(Reflect.getMetadata(LIMIT_KEY, handler)).toBe(Reflect.getMetadata(LIMIT_KEY, register));
      expect(Reflect.getMetadata(TTL_KEY, handler)).toBe(60_000);
    }
  });

  it('US-005 AC-15: both public invite routes begin returning 429 after AUTH_LOGIN_LIMIT requests', async () => {
    const limit = authLoginLimit();
    const { token } = await freshInvite();
    resetThrottle();

    let previewThrottled = false;
    let acceptThrottled = false;
    for (let i = 0; i < limit + 3; i += 1) {
      if ((await preview(token)).status === 429) previewThrottled = true;
      if ((await accept(token, { name: 'New User', password: TEST_PASSWORD })).status === 429) acceptThrottled = true;
    }

    expect(previewThrottled).toBe(true);
    expect(acceptThrottled).toBe(true);
  });
});

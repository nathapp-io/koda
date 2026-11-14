/**
 * auth-sessions US-003 — session-scoped access tokens and per-device logout on real Postgres.
 *
 * Every case goes through the booted API for DI (the provider injects `AuthSessionService`, so a wiring
 * break fails the boot) and through the real store for the state, never a stub. Two devices of one user
 * are two logins, which is what makes AC-9 meaningful: logging out one must leave the other signed in,
 * and that is only true while logout stops bumping `tokenVersion`.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/auth/session-logout.integration.spec.ts
 */
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { canRunDbTests } from '../../helpers/test-environment';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { grantBaseline } from '../../../src/permissions/test-helpers/permission-fixtures';
import { AuthService } from '../../../src/auth/auth.service';
import { AuthSessionService } from '../../../src/auth/sessions/auth-session.service';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

const TIMEOUT = 30_000;

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/** The `sid` of a signed JWT, without verifying it: the tests only need the identifier it names. */
const claims = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as Record<string, unknown>;

const sessionIdOf = (pair: TokenPair): string => {
  const sid = claims(pair.accessToken)['sid'];
  if (typeof sid !== 'string') throw new Error('access token carries no sid');
  return sid;
};

describeIntegration('per-session logout (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let authService: AuthService;
  let sessions: AuthSessionService;
  let userId: string;
  const email = `session-logout-${randomUUID()}@koda.test`;

  const actor = (): { type: 'USER'; id: string } => ({ type: 'USER', id: userId });

  const login = async (): Promise<TokenPair> =>
    data<TokenPair>(await request(server).post('/api/auth/login').send({ email, password: TEST_PASSWORD }).expect(200));

  const me = async (accessToken: string): Promise<number> =>
    (await request(server).get('/api/auth/me').set('Authorization', `Bearer ${accessToken}`)).status;

  const sessionRow = (sessionId: string) => db.authSession.findUniqueOrThrow({ where: { id: sessionId } });

  const userRow = (id: string) => db.user.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    db = fixtureDb(app);
    authService = app.get(AuthService);
    sessions = app.get(AuthSessionService);
    const user = await db.user.create({
      data: { email, name: 'Session Logout', passwordHash: await bcrypt.hash(TEST_PASSWORD, 4) },
    });
    userId = user.id;
    await grantBaseline(db, { type: 'USER', id: userId });
  }, TIMEOUT);

  afterAll(async () => {
    await app?.close();
  });

  // Every case logs in at least twice; the login route is throttled at 5/min per address.
  beforeEach(() => {
    resetThrottle(app);
  });

  it('AC-5: isActive answers false for a session revoke has just ended', async () => {
    const now = new Date();

    await withTestActor(actor(), async () => {
      await sessions.start({
        userId,
        sessionId: 's-ac5',
        tokenId: 't-ac5',
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      });

      await expect(sessions.isActive('s-ac5', now)).resolves.toBe(true);
      await expect(sessions.revoke('s-ac5', userId, 'logout', now)).resolves.toBe(true);
    });

    expect((await sessionRow('s-ac5')).revokedReason).toBe('logout');
    await expect(sessions.isActive('s-ac5', now)).resolves.toBe(false);
  }, TIMEOUT);

  it('AC-6 and AC-7: logout marks the token\'s session as logged out and leaves tokenVersion alone', async () => {
    const pair = await login();
    const sessionId = sessionIdOf(pair);
    const before = await userRow(userId);

    await request(server).post('/api/auth/logout').set('Authorization', `Bearer ${pair.accessToken}`).expect(200);

    const session = await sessionRow(sessionId);
    expect(session.revokedReason).toBe('logout');
    expect(session.revokedAt).not.toBeNull();
    // AC-7: one device ending must not bump the lever that ends every device.
    expect((await userRow(userId)).tokenVersion).toBe(before.tokenVersion);
  }, TIMEOUT);

  it('AC-8: the access token used to log out is refused on the next request', async () => {
    const pair = await login();
    // Warm the 60 s session-activity cache, so the refusal proves the direct-key eviction and not a miss.
    expect(await me(pair.accessToken)).toBe(200);

    await request(server).post('/api/auth/logout').set('Authorization', `Bearer ${pair.accessToken}`).expect(200);

    expect(await me(pair.accessToken)).toBe(401);
  }, TIMEOUT);

  it('AC-9: a second session of the same user is still signed in after the first logs out', async () => {
    const first = await login();
    const second = await login();

    await request(server).post('/api/auth/logout').set('Authorization', `Bearer ${first.accessToken}`).expect(200);

    expect(await me(second.accessToken)).toBe(200);
  }, TIMEOUT);

  it("AC-10: revoke answers false for another owner's session and leaves it untouched", async () => {
    const now = new Date();

    await withTestActor(actor(), async () => {
      await sessions.start({
        userId,
        sessionId: 's-ac10',
        tokenId: 't-ac10',
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      });

      await expect(sessions.revoke('s-ac10', 'u2', 'logout', now)).resolves.toBe(false);
    });

    expect((await sessionRow('s-ac10')).revokedAt).toBeNull();
  }, TIMEOUT);

  it("AC-14: logging out another user's session changes no tokenVersion and records the entry", async () => {
    const other = await db.user.create({
      data: { email: `session-logout-other-${randomUUID()}@koda.test`, name: 'Other', passwordHash: 'hash' },
    });
    await grantBaseline(db, { type: 'USER', id: other.id });
    const now = new Date();
    const before = await userRow(other.id);

    await withTestActor({ type: 'USER', id: other.id }, async () => {
      await sessions.start({
        userId,
        sessionId: 's-ac14',
        tokenId: 't-ac14',
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      });
      await authService.logout(other.id, 's-ac14');
    });

    // The session belongs to the first user, so nothing was revoked and no lever fired…
    expect((await sessionRow('s-ac14')).revokedAt).toBeNull();
    expect((await userRow(other.id)).tokenVersion).toBe(before.tokenVersion);
    expect((await userRow(userId)).tokenVersion).toBe(0);
    // …yet the attempt is on the record, attributed to the caller who asked.
    const entries = await db.auditEntry.findMany({ where: { key: 'session.logout', resourceId: other.id } });
    expect(entries).toHaveLength(1);
  }, TIMEOUT);
});

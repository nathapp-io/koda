import { randomUUID, createHmac } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { AUTH_CFG, IAuthConfig } from '../../../src/config/auth.config';
import { AUTH_LOGIN_LIMIT } from '../../../src/auth/auth-throttle';
import { PrismaAuthRepository } from '../../../src/auth/prisma-auth.repository';
import { AuthSessionService } from '../../../src/auth/sessions/auth-session.service';
import { hashPasswordResetToken } from '../../../src/auth/password-reset/password-reset-token';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { grantBaseline } from '../../../src/permissions/test-helpers/permission-fixtures';
import { canRunDbTests } from '../../helpers/test-environment';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';

const describeDb = canRunDbTests() ? describe : describe.skip;
const NEW_PASSWORD = 'Different123!';
type Pair = { accessToken: string; refreshToken: string };
const sid = (pair: Pair): string => (JSON.parse(Buffer.from(pair.accessToken.split('.')[1], 'base64url').toString()) as { sid: string }).sid;

/**
 * A two-way barrier for the user row lock.
 *
 * Both requests must reach `PrismaAuthRepository.lockUser` before either continues, so the interleaving
 * is the one that matters — both have verified the old password before either opens its transaction —
 * instead of whichever request happened to be scheduled first. The timeout releases a lone arrival, so a
 * missing request fails the assertions rather than hanging the suite.
 */
const LOCK_BARRIER_TIMEOUT_MS = 5_000;
function lockBarrier(expected = 2): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const timer = setTimeout(release, LOCK_BARRIER_TIMEOUT_MS);
  return async () => {
    arrived += 1;
    if (arrived >= expected) {
      clearTimeout(timer);
      release();
    }
    await gate;
  };
}

/**
 * A hand-released pause for one in-flight request (branch fix B1/B2).
 *
 * The patched call announces itself, the test does its own work, then releases it. The timeout releases a
 * pause nothing waits for, so a broken test fails its assertions instead of hanging the suite.
 */
function pause(): { announce: () => void; arrived: Promise<void>; held: Promise<void>; release: () => void } {
  let announce!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => { announce = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const timer = setTimeout(() => release(), LOCK_BARRIER_TIMEOUT_MS);
  return {
    announce,
    arrived,
    held,
    release: () => {
      clearTimeout(timer);
      release();
    },
  };
}

describeDb('password change (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let userId: string;
  let email: string;
  let pair: Pair;
  const login = async (address = email, password = TEST_PASSWORD): Promise<Pair> =>
    data<Pair>(await request(server).post('/api/auth/login').send({ email: address, password }).expect(200));
  const change = (token: string, currentPassword = TEST_PASSWORD, newPassword = NEW_PASSWORD) =>
    request(server).post('/api/auth/password').set('Authorization', `Bearer ${token}`).send({ currentPassword, newPassword });
  const me = (token: string) => request(server).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  const hash = async () => (await db.user.findUniqueOrThrow({ where: { id: userId } })).passwordHash;
  const entries = () => db.auditEntry.findMany({ where: { key: 'session.password.change', resourceId: userId } });
  /** Installs the lock barrier on the live repository instance for the duration of `run`. */
  const withLockBarrier = async <T>(run: () => Promise<T>): Promise<T> => {
    const repo = app.get(PrismaAuthRepository);
    const original = repo.lockUser;
    const barrier = lockBarrier();
    repo.lockUser = async (id: string) => {
      await barrier();
      return original.call(repo, id);
    };
    try {
      return await run();
    } finally {
      repo.lockUser = original;
    }
  };

  beforeAll(async () => { await resetDb(); app = await bootHttpApp({ registrationEnabled: false }); server = app.getHttpServer(); db = fixtureDb(app); }, 30_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    email = `${randomUUID()}@example.test`;
    const user = await db.user.create({ data: { email, name: 'Password User', passwordHash: await bcrypt.hash(TEST_PASSWORD, 4) } });
    userId = user.id;
    await grantBaseline(db, { type: 'USER', id: userId });
    pair = await login();
  });

  it('AC-1: new password logs in and old password fails', async () => {
    await change(pair.accessToken).expect(200);
    await login(email, NEW_PASSWORD);
    await request(server).post('/api/auth/login').send({ email, password: TEST_PASSWORD }).expect(401);
  });
  it('AC-2: the caller access and refresh tokens remain valid', async () => {
    await change(pair.accessToken).expect(200);
    await me(pair.accessToken).expect(200);
    await request(server).post('/api/auth/refresh').set('Authorization', `Bearer ${pair.refreshToken}`).expect(200);
  });
  it('AC-3: a cached second session is revoked immediately', async () => {
    const second = await login();
    await me(second.accessToken).expect(200);
    await change(pair.accessToken).expect(200);
    expect(await db.authSession.findUniqueOrThrow({ where: { id: sid(second) } })).toMatchObject({ revokedReason: 'password-change' });
    await me(second.accessToken).expect(401);
  });
  it('AC-4: another user session remains active', async () => {
    const otherEmail = `${randomUUID()}@example.test`;
    const other = await db.user.create({ data: { email: otherEmail, name: 'Other', passwordHash: await bcrypt.hash(TEST_PASSWORD, 4) } });
    await grantBaseline(db, { type: 'USER', id: other.id });
    const otherPair = await login(otherEmail);
    await change(pair.accessToken).expect(200);
    await me(otherPair.accessToken).expect(200);
    expect((await db.authSession.findUniqueOrThrow({ where: { id: sid(otherPair) } })).revokedAt).toBeNull();
  });
  it('AC-5: wrong current password is forbidden without writes', async () => {
    const second = await login();
    const before = await hash();
    const res = await change(pair.accessToken, 'wrong').expect(403);
    expect(JSON.stringify(res.body)).toContain('The current password is incorrect');
    expect(await hash()).toBe(before);
    expect((await db.authSession.findUniqueOrThrow({ where: { id: sid(second) } })).revokedAt).toBeNull();
  });
  it('AC-6: wrong current password records no password change audit', async () => {
    await change(pair.accessToken, 'wrong').expect(403);
    expect(await entries()).toHaveLength(0);
  });
  it('AC-7: success records exactly one audit entry', async () => {
    await change(pair.accessToken).expect(200);
    expect(await entries()).toMatchObject([{ key: 'session.password.change', resourceType: 'user', resourceId: userId, projectId: null, summary: 'password changed' }]);
    expect(await entries()).toHaveLength(1);
  });
  it('AC-8: an authenticated agent is refused without writes', async () => {
    const raw = `agent-${randomUUID()}`;
    const config = app.get<IAuthConfig>(AUTH_CFG);
    const agent = await db.agent.create({ data: { name: 'Agent', slug: randomUUID(), apiKeyHash: createHmac('sha256', config.apiKeySecret).update(raw).digest('hex'), status: 'ACTIVE' } });
    await grantBaseline(db, { type: 'AGENT', id: agent.id });
    const before = await hash();
    await request(server).get('/api/agents/me').set('Authorization', `Bearer ${raw}`).expect(200);
    await change(raw).expect(401);
    expect(await hash()).toBe(before);
    expect(await entries()).toHaveLength(0);
    expect((await db.authSession.findUniqueOrThrow({ where: { id: sid(pair) } })).revokedAt).toBeNull();
  });
  it('AC-10: short new password is rejected without changing the hash', async () => {
    const before = await hash();
    await change(pair.accessToken, TEST_PASSWORD, 'short1!').expect(400);
    expect(await hash()).toBe(before);
  });
  it('AC-11: new password without uppercase is rejected without changing the hash', async () => {
    const before = await hash();
    await change(pair.accessToken, TEST_PASSWORD, 'lowercase1!').expect(400);
    expect(await hash()).toBe(before);
  });

  /**
   * koda #466: a DTO constraint answers the API's own catalog text, in the request's language.
   *
   * The message used to be a `$t(...)` wrapper, which is not a key the validation filter can
   * translate, so the client received the placeholder verbatim. The length messages carry their
   * bound as an argument, so the answer names the number the rule asks for.
   */
  it('AC-16: a refused password answers the translated message, not the i18n placeholder', async () => {
    const res = await change(pair.accessToken, TEST_PASSWORD, 'aB1!').expect(400);
    expect(res.body.message).toBe('Must be at least 8 characters long');
    expect(res.body.errors).toEqual({ newPassword: ['Must be at least 8 characters long'] });

    const complexity = await change(pair.accessToken, TEST_PASSWORD, 'lowercase1!').expect(400);
    expect(complexity.body.message).toBe('Password must include uppercase, lowercase, number, and symbol');

    // No placeholder reaches the client, in any language.
    const chinese = await request(server)
      .post('/api/auth/password')
      .set('Authorization', `Bearer ${pair.accessToken}`)
      .set('Accept-Language', 'zh')
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'lowercase1!' })
      .expect(400);
    expect(JSON.stringify(chinese.body)).not.toContain('$t(');
    expect(chinese.body.message).toBe('密码必须包含大写字母、小写字母、数字和特殊字符');
  });
  it('AC-15: password change uses the login throttle', async () => {
    for (let i = 0; i < AUTH_LOGIN_LIMIT; i++) await change(pair.accessToken, 'wrong').expect(403);
    await change(pair.accessToken, 'wrong').expect(429);
  });

  it('B1: two concurrent changes both verifying the old password write one password, and the loser answers 403', async () => {
    // Two sessions of the same account: each request proves the same current password.
    const second = await login();
    const firstPassword = 'Racing123!Aa';
    const secondPassword = 'Stale123!Aa';

    const [first, other] = await withLockBarrier(() => Promise.all([
      change(pair.accessToken, TEST_PASSWORD, firstPassword),
      change(second.accessToken, TEST_PASSWORD, secondPassword),
    ]));

    // Exactly one commits; the stale request is refused instead of overwriting the change that won.
    expect([first.status, other.status].sort()).toEqual([200, 403]);
    const refused = first.status === 403 ? first : other;
    expect(JSON.stringify(refused.body)).toContain('The current password is incorrect');

    // Whichever request won owns the account password; the other one never became a password.
    const winnerPassword = first.status === 200 ? firstPassword : secondPassword;
    const loserPassword = first.status === 200 ? secondPassword : firstPassword;
    await login(email, winnerPassword);
    await request(server).post('/api/auth/login').send({ email, password: loserPassword }).expect(401);
    // One committed change, so one entry — the refused request wrote nothing at all.
    expect(await entries()).toHaveLength(1);
  });

  it('B2: a change racing a reset confirmation deadlocks neither and leaves exactly one password', async () => {
    const raw = `racing-${randomUUID()}`;
    await db.passwordResetToken.create({
      data: { userId, tokenHash: hashPasswordResetToken(raw), expiresAt: new Date(Date.now() + 60_000) },
    });

    const [changed, confirmed] = await withLockBarrier(() => Promise.all([
      change(pair.accessToken, TEST_PASSWORD, 'Change123!Aa'),
      request(server).post('/api/auth/password-reset/confirm').send({ token: raw, newPassword: 'Reset123!Aa' }),
    ]));

    // One lock order means neither transaction is a deadlock victim: no 5xx, and exactly one 200.
    expect(changed.status).toBeLessThan(500);
    expect(confirmed.status).toBeLessThan(500);
    expect([changed.status, confirmed.status].filter((status) => status === 200)).toHaveLength(1);
    const refusal = changed.status === 200 ? confirmed : changed;
    // The change that lost is refused as stale (403) or as a spent token (400); nothing else.
    expect([400, 403]).toContain(refusal.status);

    const winner = changed.status === 200 ? 'Change123!Aa' : 'Reset123!Aa';
    const other = changed.status === 200 ? 'Reset123!Aa' : 'Change123!Aa';
    await login(email, winner);
    await request(server).post('/api/auth/login').send({ email, password: other }).expect(401);
  });

  it('B1: a login that proved the old password writes no session once a change has committed', async () => {
    // The sign-in already compared the old password: it is held just before the session and its first
    // refresh token are written, which is the window a password change has to be able to close.
    const sessions = app.get(AuthSessionService);
    const originalStart = sessions.start;
    const paused = pause();
    sessions.start = async (input, fence) => {
      paused.announce();
      await paused.held;
      return originalStart.call(sessions, input, fence);
    };
    try {
      // `.then(...)` dispatches the request now: the assertions below depend on it being in flight.
      const staleLogin = request(server)
        .post('/api/auth/login')
        .send({ email, password: TEST_PASSWORD })
        .then((response) => response);
      await paused.arrived;

      // The change commits while the login is paused: it revokes every session of the user and leaves
      // `tokenVersion` alone, so a session created after it would refresh forever.
      await change(pair.accessToken).expect(200);
      paused.release();

      const refused = await staleLogin;
      expect(refused.status).toBe(401);
      expect(JSON.stringify(refused.body)).not.toContain('refreshToken');
    } finally {
      paused.release();
      sessions.start = originalStart;
    }

    // Only the changing caller's session exists: the refused sign-in wrote no session and no token.
    expect(await db.authSession.count({ where: { userId } })).toBe(1);
    expect(await login(email, NEW_PASSWORD)).toBeTruthy();
  });

  it('B2: a user disabled between the lookup and the user row lock is refused, writing nothing', async () => {
    const repo = app.get(PrismaAuthRepository);
    const originalLock = repo.lockUser;
    const paused = pause();
    repo.lockUser = async (id: string) => {
      paused.announce();
      await paused.held;
      return originalLock.call(repo, id);
    };
    const before = await hash();
    try {
      // `.then(...)` dispatches the request now: the pause below holds it inside its transaction.
      const pending = change(pair.accessToken).then((response) => response);
      await paused.arrived;

      // The administrative disable commits after the service read the row (not disabled) and before its
      // transaction takes the lock, so only the locked read can see it.
      await db.user.update({ where: { id: userId }, data: { disabled: true } });
      paused.release();

      const refused = await pending;
      expect(refused.status).toBe(401);
    } finally {
      paused.release();
      repo.lockUser = originalLock;
    }

    expect(await hash()).toBe(before);
    expect(await entries()).toHaveLength(0);
    expect((await db.authSession.findUniqueOrThrow({ where: { id: sid(pair) } })).revokedAt).toBeNull();
  });
});

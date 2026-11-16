import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { NOTIFY_SERVICE } from '@nathapp/nestjs-notify';
import { AUTH_LOGIN_LIMIT } from '../../../src/auth/auth-throttle';
import { PrismaAuthRepository } from '../../../src/auth/prisma-auth.repository';
import { hashPasswordResetToken } from '../../../src/auth/password-reset/password-reset-token';
import { EmailDispatcher } from '../../../src/email/email-dispatcher';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { grantBaseline } from '../../../src/permissions/test-helpers/permission-fixtures';
import { canRunDbTests } from '../../helpers/test-environment';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';

/**
 * auth-passwords US-004 — the public reset confirmation route.
 *
 * Every token this file confirms was emailed by a real `POST /api/auth/password-reset`: the request
 * task is detached, so the token is read back out of the `sendOne` call with one bounded wait (5 s).
 * The app boots with audit coverage in `throw` mode, so a write no audit entry covers fails the request
 * with a 500 instead of passing silently.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/auth/password-reset-confirm.integration.spec.ts
 */
const describeDb = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

/** The bounded wait for the detached request task (it may finish after the request answered). */
const WAIT_MS = 5_000;
const POLL_MS = 25;
const NEW_PASSWORD = 'Replacement123!Aa';
const RESET_PATH = '/reset-password/';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * A hand-released pause for one in-flight request (branch fix B2): the patched call announces itself, the
 * test does its own work, then releases it. The timeout releases a pause nothing waits for, so a broken
 * test fails its assertions instead of hanging the suite.
 */
const PAUSE_TIMEOUT_MS = 5_000;
function pause(): { announce: () => void; arrived: Promise<void>; held: Promise<void>; release: () => void } {
  let announce!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => { announce = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const timer = setTimeout(() => release(), PAUSE_TIMEOUT_MS);
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

async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, what: string): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${WAIT_MS} ms waiting for ${what}`);
    await sleep(POLL_MS);
  }
}

/** `auth.resetTokenInvalid` as `apps/api/src/i18n/en/auth.json` declares it, at its exception code. */
const authTranslations = JSON.parse(
  readFileSync(join(__dirname, '../../../src/i18n/en/auth.json'), 'utf8'),
) as { resetTokenInvalid?: Record<string, string> };

/** Resolved per assertion, so a missing key fails the case that renders it, not the whole file. */
function resetTokenInvalid(): string {
  const sentence = authTranslations.resetTokenInvalid?.['-2'];
  if (typeof sentence !== 'string') {
    throw new Error('auth.resetTokenInvalid.-2 is not declared in src/i18n/en/auth.json');
  }
  return sentence;
}

interface ResetEmailCall {
  row: { toEmail: string };
  payload: { url: string };
}

describeDb('password reset confirm (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let send: ReturnType<typeof vi.spyOn>;
  let sendOne: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  let userId: string;
  let userEmail: string;
  const previous = {
    SMTP_URL: process.env['SMTP_URL'],
    EMAIL_FROM: process.env['EMAIL_FROM'],
    WEB_PUBLIC_URL: process.env['WEB_PUBLIC_URL'],
  };

  const rawTokenOf = (url: string): string => url.slice(url.lastIndexOf(RESET_PATH) + RESET_PATH.length);
  const tokenRows = (id: string) => db.passwordResetToken.findMany({ where: { userId: id } });
  const unusedRows = (id: string) => db.passwordResetToken.findMany({ where: { userId: id, usedAt: null } });
  const passwordHash = async (id = userId): Promise<string> =>
    (await db.user.findUniqueOrThrow({ where: { id } })).passwordHash;
  const tokenVersion = async (id = userId): Promise<number> =>
    (await db.user.findUniqueOrThrow({ where: { id } })).tokenVersion;
  const confirmEntries = (id = userId) =>
    db.auditEntry.findMany({ where: { key: 'session.password.reset.confirm', resourceId: id } });
  const confirm = (token: string, newPassword: string = NEW_PASSWORD, acceptLanguage?: string) => {
    const call = request(server).post('/api/auth/password-reset/confirm').send({ token, newPassword });
    return acceptLanguage === undefined ? call : call.set('Accept-Language', acceptLanguage);
  };
  const login = (password: string, address = userEmail) =>
    request(server).post('/api/auth/login').send({ email: address, password });
  const me = (accessToken: string) =>
    request(server).get('/api/auth/me').set('Authorization', `Bearer ${accessToken}`);
  const requestReset = (address: string) =>
    request(server).post('/api/auth/password-reset').send({ email: address });

  const createUser = async (address: string): Promise<string> => {
    const user = await db.user.create({
      data: { email: address, name: 'Reset User', passwordHash: await bcrypt.hash(TEST_PASSWORD, 4) },
    });
    await grantBaseline(db, { type: 'USER', id: user.id });
    return user.id;
  };

  /** Runs the real request route and answers the raw token one real reset email carried. */
  const emailedToken = async (address: string): Promise<string> => {
    const before = (sendOne.mock.calls as unknown as [ResetEmailCall['row']][]).length;
    await requestReset(address).expect(200);

    const call = await waitFor(async () => {
      const calls = (sendOne.mock.calls as unknown as [ResetEmailCall['row'], string, ResetEmailCall['payload']][])
        .slice(before)
        .filter(([row]) => row.toEmail === address);
      return calls.length > 0 ? calls[0] : null;
    }, `the reset email for ${address}`);

    return rawTokenOf(call[2].url);
  };

  beforeAll(async () => {
    // The reset path only runs when email is configured (D520).
    process.env['SMTP_URL'] = 'smtp://127.0.0.1:2525';
    process.env['EMAIL_FROM'] = 'koda@example.com';
    process.env['WEB_PUBLIC_URL'] = 'https://koda.example.test';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    db = fixtureDb(app);
    // File-level spies: a detached task can still be running when a test ends, and a restored spy
    // would hand that send to the real SMTP channel.
    send = vi.spyOn(app.get<{ send: () => Promise<unknown> }>(NOTIFY_SERVICE), 'send');
    sendOne = vi.spyOn(app.get(EmailDispatcher), 'sendOne');
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await app?.close();
    send.mockRestore();
    sendOne.mockRestore();
  });

  beforeEach(async () => {
    resetThrottle(app);
    userEmail = `${randomUUID()}@example.test`;
    userId = await createUser(userEmail);
    send.mockReset().mockResolvedValue({} as never);
    sendOne.mockClear();
    warn.mockClear();
  });

  it('AC-1: a confirm with the emailed token and a valid newPassword answers 200 {} and the new password logs in', async () => {
    const token = await emailedToken(userEmail);

    const response = await confirm(token).expect(200);
    expect(response.body).toEqual({ ret: 0, data: {} });

    const accepted = await login(NEW_PASSWORD).expect(200);
    expect(data<{ accessToken: string }>(accepted).accessToken).toBeTruthy();
  });

  it('AC-2: the token is marked used, and a second confirm with it answers 400 auth.resetTokenInvalid', async () => {
    const token = await emailedToken(userEmail);
    await confirm(token).expect(200);

    const [row] = await tokenRows(userId);
    expect(row.usedAt).toBeInstanceOf(Date);

    const rejected = await confirm(token).expect(400);
    expect(rejected.body).toMatchObject({ ret: -2, message: resetTokenInvalid() });
    // The second confirm changed nothing: the password is still the one the first confirm wrote.
    await login(NEW_PASSWORD).expect(200);
  });

  it('AC-3: an expired token answers 400 auth.resetTokenInvalid and leaves the password unchanged', async () => {
    const token = await emailedToken(userEmail);
    const before = await passwordHash();
    await db.passwordResetToken.updateMany({
      where: { tokenHash: hashPasswordResetToken(token) },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const response = await confirm(token).expect(400);
    expect(response.body).toMatchObject({ ret: -2, message: resetTokenInvalid() });
    expect(await passwordHash()).toBe(before);
    expect((await tokenRows(userId))[0].usedAt).toBeNull();
    expect(await confirmEntries()).toEqual([]);
  });

  it('AC-4: an unknown token answers 400 auth.resetTokenInvalid and writes nothing', async () => {
    const before = { hash: await passwordHash(), version: await tokenVersion() };

    const response = await confirm(`unknown-${randomUUID()}`).expect(400);
    expect(response.body).toMatchObject({ ret: -2, message: resetTokenInvalid() });

    expect(await passwordHash()).toBe(before.hash);
    expect(await tokenVersion()).toBe(before.version);
    expect(await db.authSession.count({ where: { userId } })).toBe(0);
    expect(await db.auditEntry.count({ where: { resourceId: userId } })).toBe(0);
  });

  it('AC-5: a user disabled after the request answers 400 auth.resetTokenInvalid and leaves the password unchanged', async () => {
    const token = await emailedToken(userEmail);
    const before = await passwordHash();
    await db.user.update({ where: { id: userId }, data: { disabled: true } });

    const response = await confirm(token).expect(400);
    expect(response.body).toMatchObject({ ret: -2, message: resetTokenInvalid() });
    expect(await passwordHash()).toBe(before);
    expect((await tokenRows(userId))[0].usedAt).toBeNull();
  });

  it('AC-6: a cached session is revoked as password-reset and its access token answers 401 right after the confirm', async () => {
    const token = await emailedToken(userEmail);
    const pair = data<{ accessToken: string }>(await login(TEST_PASSWORD).expect(200));
    // The first /me fills the 60 s session-activity answer the confirm must evict.
    await me(pair.accessToken).expect(200);

    await confirm(token).expect(200);

    const sessionId = (JSON.parse(
      Buffer.from(pair.accessToken.split('.')[1], 'base64url').toString(),
    ) as { sid: string }).sid;
    expect(await db.authSession.findUniqueOrThrow({ where: { id: sessionId } }))
      .toMatchObject({ revokedReason: 'password-reset' });
    await me(pair.accessToken).expect(401);
  });

  it('AC-7: a successful confirm raises the tokenVersion by one', async () => {
    const token = await emailedToken(userEmail);
    const before = await tokenVersion();

    await confirm(token).expect(200);

    expect(await tokenVersion()).toBe(before + 1);
  });

  it('AC-8: a successful confirm deletes the user\'s other unused reset tokens', async () => {
    const token = await emailedToken(userEmail);
    const other = await db.passwordResetToken.create({
      data: {
        userId,
        tokenHash: hashPasswordResetToken(`other-${randomUUID()}`),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await confirm(token).expect(200);

    expect(await db.passwordResetToken.findUnique({ where: { id: other.id } })).toBeNull();
    expect(await unusedRows(userId)).toEqual([]);
    // The presented token is kept, marked used — the record of the reset that happened.
    const remaining = await tokenRows(userId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].usedAt).toBeInstanceOf(Date);
  });

  it('AC-9: a successful confirm records exactly one audit entry with the reset fields', async () => {
    const token = await emailedToken(userEmail);

    await confirm(token).expect(200);

    expect(await confirmEntries()).toMatchObject([{
      key: 'session.password.reset.confirm',
      resourceType: 'user',
      resourceId: userId,
      projectId: null,
      summary: 'password reset',
    }]);
    expect(await confirmEntries()).toHaveLength(1);
  });

  it('AC-10: two concurrent confirms answer one 200 and one 400, with exactly one audit entry', async () => {
    const token = await emailedToken(userEmail);

    const responses = await Promise.all([confirm(token), confirm(token)]);
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 400]);

    const rejected = responses.find((response) => response.status === 400);
    expect(rejected?.body).toMatchObject({ ret: -2, message: resetTokenInvalid() });
    expect(await confirmEntries()).toHaveLength(1);
  });

  it('AC-11: password validation answers localized 400 before token use', async () => {
    const token = await emailedToken(userEmail);
    const before = await passwordHash();

    await confirm(token, 'lowercase1!').expect(400);

    const english = await confirm(token, 'aB1!').expect(400);
    expect(english.body.message).toBe('Must be at least 8 characters long');

    const chinese = await confirm(token, 'aB1!', 'zh-CN').expect(400);
    expect(chinese.body.message).toBe('长度至少为 8 个字符');
    expect(chinese.body.errors.newPassword).toEqual(['长度至少为 8 个字符']);
    expect(JSON.stringify(chinese.body)).not.toContain('$t(');

    expect(await passwordHash()).toBe(before);
    expect(await unusedRows(userId)).toHaveLength(1);
    expect(await confirmEntries()).toEqual([]);
  });

  it('AC-12: is throttled like login', async () => {
    for (let i = 0; i < AUTH_LOGIN_LIMIT; i += 1) await confirm(`unknown-${randomUUID()}`).expect(400);
    await confirm(`unknown-${randomUUID()}`).expect(429);
  });

  it('B2: a user disabled between the token lookup and the user row lock is refused, writing nothing', async () => {
    // The token row was read (and not disabled then) and the new hash is being computed: the disable
    // commits before the transaction takes the lock, so only the locked read can see it.
    const token = await emailedToken(userEmail);
    const before = await passwordHash();
    const repo = app.get(PrismaAuthRepository);
    const originalLock = repo.lockUser;
    const paused = pause();
    repo.lockUser = async (id: string) => {
      paused.announce();
      await paused.held;
      return originalLock.call(repo, id);
    };
    try {
      // `.then(...)` dispatches the request now: the pause below holds it inside its transaction.
      const pending = confirm(token).then((response) => response);
      await paused.arrived;
      await db.user.update({ where: { id: userId }, data: { disabled: true } });
      paused.release();

      const response = await pending;
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ ret: -2, message: resetTokenInvalid() });
    } finally {
      paused.release();
      repo.lockUser = originalLock;
    }

    expect(await passwordHash()).toBe(before);
    expect((await tokenRows(userId))[0].usedAt).toBeNull();
    expect(await confirmEntries()).toEqual([]);
  });

  it('AC-14: the confirm issues no tokens and creates no session', async () => {
    const token = await emailedToken(userEmail);
    // One session of the user already exists, so a session created by the confirm would show up.
    await login(TEST_PASSWORD).expect(200);
    const sessionsBefore = await db.authSession.count({ where: { userId } });

    const response = await confirm(token).expect(200);

    expect(response.body).toEqual({ ret: 0, data: {} });
    expect(response.body).not.toHaveProperty('data.accessToken');
    expect(response.body).not.toHaveProperty('data.refreshToken');
    expect(JSON.stringify(response.body)).not.toContain('Token');
    expect(await db.authSession.count({ where: { userId } })).toBe(sessionsBefore);
  });
});

import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { NOTIFY_SERVICE } from '@nathapp/nestjs-notify';
import { AUTH_LOGIN_LIMIT } from '../../../src/auth/auth-throttle';
import { PASSWORD_RESET_TTL_MS } from '../../../src/auth/password-reset/password-reset.constants';
import { hashPasswordResetToken } from '../../../src/auth/password-reset/password-reset-token';
import { EmailAvailability } from '../../../src/email/email-availability';
import { EmailDispatcher } from '../../../src/email/email-dispatcher';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { grantBaseline } from '../../../src/permissions/test-helpers/permission-fixtures';
import { canRunDbTests } from '../../helpers/test-environment';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';

/**
 * auth-passwords US-003 — the public reset-request route.
 *
 * The token write and the email are detached from the response, so every case polls the database for
 * the detached work with one bounded wait (5 s). The app boots with audit-coverage checking on (the
 * integration harness's default `throw` mode), so a write that no audit entry covers fails the
 * request with a 500 instead of passing silently (AC-9).
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/auth/password-reset-request.integration.spec.ts
 */
const describeDb = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

/** The bounded wait every case shares: the detached task may finish after the response. */
const WAIT_MS = 5_000;
const POLL_MS = 25;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Polls `probe` until it answers a truthy value, for at most `WAIT_MS`. */
async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, what: string): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${WAIT_MS} ms waiting for ${what}`);
    await sleep(POLL_MS);
  }
}

const resetPath = '/reset-password/';
const rawTokenOf = (url: string): string => url.slice(url.lastIndexOf(resetPath) + resetPath.length);

describeDb('password reset request (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let dispatcher: EmailDispatcher;
  let email: EmailAvailability;
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

  const requestReset = (address: string, acceptLanguage?: string) => {
    const call = request(server).post('/api/auth/password-reset').send({ email: address });
    return acceptLanguage === undefined ? call : call.set('Accept-Language', acceptLanguage);
  };
  const tokenRows = (id: string) => db.passwordResetToken.findMany({ where: { userId: id } });
  const unusedRows = (id: string) => db.passwordResetToken.findMany({ where: { userId: id, usedAt: null } });
  const scheduleRows = (address: string) =>
    db.emailSchedule.findMany({ where: { toEmail: address, kind: 'PASSWORD_RESET' } });
  const createUser = async (address: string, disabled = false): Promise<string> => {
    const user = await db.user.create({
      data: { email: address, name: 'Reset User', passwordHash: await bcrypt.hash(TEST_PASSWORD, 4), disabled },
    });
    await grantBaseline(db, { type: 'USER', id: user.id });
    return user.id;
  };

  beforeAll(async () => {
    // Email must be configured for the reset path to run at all (D520).
    process.env['SMTP_URL'] = 'smtp://127.0.0.1:2525';
    process.env['EMAIL_FROM'] = 'koda@example.com';
    process.env['WEB_PUBLIC_URL'] = 'https://koda.example.test';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    db = fixtureDb(app);
    dispatcher = app.get(EmailDispatcher);
    email = app.get(EmailAvailability);
    // File-level spies: a detached task can still be running when a test ends, and a restored spy
    // would hand that send to the real SMTP channel.
    send = vi.spyOn(app.get<{ send: () => Promise<unknown> }>(NOTIFY_SERVICE), 'send');
    sendOne = vi.spyOn(dispatcher, 'sendOne');
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
    // The send step runs for real; only the SMTP call is stubbed.
    send.mockReset().mockResolvedValue({} as never);
    sendOne.mockClear();
    warn.mockClear();
  });

  it('AC-1: answers 200 {} and writes one unused token expiring in 30 minutes', async () => {
    const requestedAt = Date.now();
    const response = await requestReset(userEmail).expect(200);

    expect(response.body).toEqual({ ret: 0, data: {} });

    const [row] = await waitFor(async () => {
      const rows = await unusedRows(userId);
      return rows.length > 0 ? rows : null;
    }, 'the reset token row');

    expect(row.usedAt).toBeNull();
    expect(row.expiresAt.getTime() - requestedAt).toBeGreaterThan(PASSWORD_RESET_TTL_MS - 2_000);
    expect(row.expiresAt.getTime() - requestedAt).toBeLessThan(PASSWORD_RESET_TTL_MS + 2_000);
  });

  it('AC-2: stores the lowercase sha256 hex of the emailed token and no raw token anywhere', async () => {
    await requestReset(userEmail).expect(200);
    const [row] = await waitFor(async () => {
      const rows = await unusedRows(userId);
      return rows.length > 0 ? rows : null;
    }, 'the reset token row');
    const [call] = await waitFor(async () => {
      const calls = sendOne.mock.calls as unknown as [unknown, string, { url: string }][];
      return calls.length > 0 ? calls : null;
    }, 'the reset email');

    const raw = rawTokenOf(call[2].url);
    expect(raw.length).toBeGreaterThan(20);
    expect(row.tokenHash).toBe(hashPasswordResetToken(raw));
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.tokenHash).not.toBe(raw);

    const stored = JSON.stringify(await tokenRows(userId));
    expect(stored).not.toContain(raw);
  });

  it('AC-3: sends PASSWORD_RESET through sendOne with the web url and retry disabled', async () => {
    await requestReset(userEmail).expect(200);
    const [call] = await waitFor(async () => {
      const calls = sendOne.mock.calls as unknown as [
        { id: string; kind: string }, string, { url: string; expiresAt: string }, string, Date, boolean,
      ][];
      return calls.length > 0 ? calls : null;
    }, 'the reset email');

    const [row, templateCode, payload, recipient, now, retryable] = call;
    const raw = rawTokenOf(payload.url);
    expect(row).toMatchObject({ kind: 'PASSWORD_RESET' });
    expect(templateCode).toBe('PASSWORD_RESET');
    expect(payload.url).toBe(email.webUrl(`/reset-password/${raw}`));
    expect(payload.expiresAt).toEqual(expect.any(String));
    expect(recipient).toBe(userId);
    expect(now).toBeInstanceOf(Date);
    expect(retryable).toBe(false);
  });

  it('AC-4: writes one PASSWORD_RESET schedule row for the user and ends it SENT', async () => {
    await requestReset(userEmail).expect(200);

    const row = await waitFor(async () => {
      const rows = await scheduleRows(userEmail);
      return rows.find((entry) => entry.status === 'SENT') ?? null;
    }, 'the SENT schedule row');

    expect(row).toMatchObject({ kind: 'PASSWORD_RESET', userId, status: 'SENT' });
    expect(await scheduleRows(userEmail)).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('AC-5: a throwing email channel still answers 200 {} and ends the row FAILED, logged as a warning', async () => {
    send.mockRejectedValue(new Error('smtp refused the connection'));

    const response = await requestReset(userEmail).expect(200);
    expect(response.body).toEqual({ ret: 0, data: {} });

    const row = await waitFor(async () => {
      const rows = await scheduleRows(userEmail);
      return rows.find((entry) => entry.status === 'FAILED') ?? null;
    }, 'the FAILED schedule row');

    expect(row.kind).toBe('PASSWORD_RESET');
    // A warning that names this request's user, so a warning from any other test cannot satisfy it.
    expect(warn.mock.calls.some(([message]) => String(message).includes(userId))).toBe(true);
  });

  it('AC-6: an unknown address answers 200 {} and writes nothing, with the same wait', async () => {
    const unknown = `nobody-${randomUUID()}@example.test`;
    const response = await requestReset(unknown).expect(200);
    expect(response.body).toEqual({ ret: 0, data: {} });

    // The control request proves the detached machinery ran to completion inside the same wait.
    await requestReset(userEmail).expect(200);
    await waitFor(async () => (await scheduleRows(userEmail)).length > 0, 'the control schedule row');
    await sleep(250);

    expect(await scheduleRows(unknown)).toEqual([]);
    expect(await db.user.count({ where: { email: unknown } })).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect((sendOne.mock.calls as unknown as [{ toEmail: string }][]).filter(([row]) => row.toEmail === unknown))
      .toEqual([]);
  });

  it('AC-7: a disabled user answers 200 {} and gets no token and no email', async () => {
    const disabledEmail = `${randomUUID()}@example.test`;
    const disabledId = await createUser(disabledEmail, true);

    await requestReset(disabledEmail).expect(200);
    await sleep(250);

    expect(await tokenRows(disabledId)).toEqual([]);
    expect(await scheduleRows(disabledEmail)).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('AC-8: with email unconfigured it answers 200 {} and writes nothing', async () => {
    const configured = vi.spyOn(email, 'configured', 'get').mockReturnValue(false);

    await requestReset(userEmail).expect(200);
    await sleep(250);
    configured.mockRestore();

    expect(await tokenRows(userId)).toEqual([]);
    expect(await scheduleRows(userEmail)).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('AC-9: known and unknown addresses answer the same body and neither is an unaudited write', async () => {
    const unknown = `nobody-${randomUUID()}@example.test`;

    const known = await requestReset(userEmail).expect(200);
    const anonymous = await requestReset(unknown).expect(200);

    expect(known.body).toEqual(anonymous.body);
    expect(known.body).toEqual({ ret: 0, data: {} });
    // Audit coverage runs in `throw` mode here, so an uncovered write would have answered 500.
    expect(known.text).not.toContain('unaudited write');
    expect(anonymous.text).not.toContain('unaudited write');
  });

  it('AC-10: a second request leaves exactly one unused token row', async () => {
    await requestReset(userEmail).expect(200);
    await waitFor(async () => (await scheduleRows(userEmail)).length === 1, 'the first reset');
    await requestReset(userEmail).expect(200);
    await waitFor(async () => (await scheduleRows(userEmail)).length === 2, 'the second reset');

    expect(await unusedRows(userId)).toHaveLength(1);
    expect(await tokenRows(userId)).toHaveLength(1);
  });

  it('AC-11: Accept-Language zh-CN writes locale zh and fr writes en', async () => {
    await requestReset(userEmail, 'zh-CN,zh;q=0.9').expect(200);
    const chinese = await waitFor(async () => {
      const rows = await scheduleRows(userEmail);
      return rows.find((entry) => entry.locale === 'zh') ?? null;
    }, 'the zh schedule row');
    expect(chinese.locale).toBe('zh');

    const frenchEmail = `${randomUUID()}@example.test`;
    await createUser(frenchEmail);
    await requestReset(frenchEmail, 'fr-FR,fr;q=0.8').expect(200);
    const english = await waitFor(async () => {
      const rows = await scheduleRows(frenchEmail);
      return rows.length > 0 ? rows[0] : null;
    }, 'the en schedule row');
    expect(english.locale).toBe('en');
  });

  it('AC-12: is throttled like login', async () => {
    for (let i = 0; i < AUTH_LOGIN_LIMIT; i += 1) await requestReset(userEmail).expect(200);
    await requestReset(userEmail).expect(429);
  });

  it('AC-14: a successful password change deletes the outstanding reset token', async () => {
    await requestReset(userEmail).expect(200);
    await waitFor(async () => (await unusedRows(userId)).length === 1, 'the reset token row');

    const login = await request(server)
      .post('/api/auth/login')
      .send({ email: userEmail, password: TEST_PASSWORD })
      .expect(200);
    const { accessToken } = data<{ accessToken: string }>(login);
    await request(server)
      .post('/api/auth/password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'Replacement123!Aa' })
      .expect(200);

    // US-004 owns the confirm route; the token it would present is gone, so it can no longer be used.
    expect(await unusedRows(userId)).toEqual([]);
  });

  it('AC-15: a body that is not an email address answers 400 and writes nothing', async () => {
    const response = await requestReset('not-an-address').expect(400);

    expect(JSON.stringify(response.body)).not.toBe('{}');
    expect(await tokenRows(userId)).toEqual([]);
    expect(await scheduleRows('not-an-address')).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});

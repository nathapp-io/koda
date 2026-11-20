import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import {
  DELIVERY_CHANNEL_REGISTRY, DeliveryChannelRegistry, INotifyService, NOTIFY_SERVICE, NotificationChannel,
} from '@nathapp/nestjs-notify';
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
import { fixtureDb, withTestActor } from '../../helpers/action-context';

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

/**
 * The negative twin of `waitFor`: watches for a forbidden write across the whole `WAIT_MS` bound and
 * answers how many times it looked. It throws the moment `probe` reports one, so a write that landed
 * late cannot hide behind a short sleep — the address is observed for the same window the positive
 * cases allow the detached task to take.
 */
async function observeAbsence(probe: () => Promise<string | null>, what: string): Promise<number> {
  const deadline = Date.now() + WAIT_MS;
  let polls = 0;
  for (;;) {
    const violation = await probe();
    polls += 1;
    if (violation !== null) throw new Error(`${what}: ${violation}`);
    if (Date.now() >= deadline) return polls;
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
  let providerSend: ReturnType<typeof vi.spyOn>;
  let sendOne: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  let delayedProviderCompleted: boolean;
  let userId: string;
  let userEmail: string;
  const previous = {
    SMTP_URL: process.env['SMTP_URL'],
    EMAIL_FROM: process.env['EMAIL_FROM'],
    WEB_PUBLIC_URL: process.env['WEB_PUBLIC_URL'],
  };

  const requestedDeliveryCounts = new Map<string, number>();
  const requestReset = async (address: string, acceptLanguage?: string, expectedStatus = 200) => {
    const call = request(server).post('/api/auth/password-reset').send({ email: address });
    if (acceptLanguage !== undefined) call.set('Accept-Language', acceptLanguage);
    const response = await call.expect(expectedStatus);
    if (response.status === 200 && email.configured) {
      const user = await db.user.findUnique({ where: { email: address }, select: { disabled: true } });
      if (user && !user.disabled) {
        requestedDeliveryCounts.set(address, (requestedDeliveryCounts.get(address) ?? 0) + 1);
      }
    }
    return response;
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
    send = vi.spyOn(app.get<INotifyService>(NOTIFY_SERVICE), 'send');
    const channel = app.get<DeliveryChannelRegistry>(DELIVERY_CHANNEL_REGISTRY).get(NotificationChannel.EMAIL);
    if (!channel) throw new Error('email channel not registered');
    providerSend = vi.spyOn(channel, 'send').mockResolvedValue({ providerMessageId: 'reset-test' });
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
    providerSend.mockRestore();
    sendOne.mockRestore();
  });

  afterEach(async () => {
    const terminal = new Set(['SENT', 'FAILED', 'SKIPPED']);
    for (const [address, expectedCount] of requestedDeliveryCounts) {
      await waitFor(async () => {
        const rows = await scheduleRows(address);
        return rows.length >= expectedCount && rows.every((row) => terminal.has(row.status)) ? true : null;
      }, `all ${expectedCount} detached reset send(s) for ${address} to finish`);
    }
    requestedDeliveryCounts.clear();
  });

  beforeEach(async () => {
    requestedDeliveryCounts.clear();
    resetThrottle(app);
    userEmail = `${randomUUID()}@example.test`;
    userId = await createUser(userEmail);
    // The send step runs for real; only the SMTP call is stubbed.
    send.mockClear();
    providerSend.mockClear().mockResolvedValue({ providerMessageId: 'reset-test' });
    sendOne.mockClear();
    warn.mockClear();
  });

  it('leaves a delayed detached provider call for teardown to drain', async () => {
    delayedProviderCompleted = false;
    providerSend.mockImplementation(async () => {
      await sleep(500);
      delayedProviderCompleted = true;
      return { providerMessageId: 'delayed-reset' };
    });

    await requestReset(userEmail);
    await waitFor(async () => providerSend.mock.calls.length > 0, 'the delayed detached provider call');
  });

  it('does not begin the next test until the prior detached provider call completes', () => {
    expect(delayedProviderCompleted).toBe(true);
  });

  it('AC-1: answers 200 {} and writes one unused token expiring in 30 minutes', async () => {
    const requestedAt = Date.now();
    const response = await requestReset(userEmail);

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
    await requestReset(userEmail);
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
    await requestReset(userEmail);
    const [call] = await waitFor(async () => {
      const calls = sendOne.mock.calls as unknown as [
        { id: string; kind: string }, string, { url: string; expiresAt: string }, string | null, Date, boolean,
      ][];
      return calls.length > 0 ? calls : null;
    }, 'the reset email');

    const [row, templateCode, payload, recipient, now, retryable] = call;
    const raw = rawTokenOf(payload.url);
    expect(row).toMatchObject({ kind: 'PASSWORD_RESET' });
    expect(templateCode).toBe('PASSWORD_RESET');
    expect(payload.url).toBe(email.webUrl(`/reset-password/${raw}`));
    expect(payload.expiresAt).toEqual(expect.any(String));
    expect(recipient).toBeNull();
    expect(now).toBeInstanceOf(Date);
    expect(retryable).toBe(false);
  });

  it('AC-1/AC-2/AC-3/AC-4: delivers opted-out reset mail through real notify with attribution and token match', async () => {
    await db.notificationPreference.create({
      data: { userId, tenantId: 'default', channel: 'email', enabled: false },
    });

    const response = await requestReset(userEmail, 'zh-CN');
    expect(response.body).toEqual({ ret: 0, data: {} });

    const row = await waitFor(async () => {
      const rows = await scheduleRows(userEmail);
      return rows.find((entry) => entry.status === 'SENT') ?? null;
    }, 'the opted-out reset schedule row to finish');
    expect(row).toMatchObject({ status: 'SENT', kind: 'PASSWORD_RESET', userId, toEmail: userEmail, locale: 'zh' });
    expect(providerSend).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);

    const [payload, rendered] = providerSend.mock.calls[0] as unknown as [
      { recipient: string; locale: string; templateCode: string }, string,
    ];
    expect(payload).toMatchObject({ recipient: userEmail, locale: 'zh', templateCode: 'PASSWORD_RESET' });
    const raw = rendered.match(/reset-password\/([A-Za-z0-9_-]+)/)?.[1];
    if (!raw) throw new Error('rendered reset email did not contain its reset link');
    expect(rendered).toContain(email.webUrl(`/reset-password/${raw}`));
    const [token] = await unusedRows(userId);
    expect(token.tokenHash).toBe(hashPasswordResetToken(raw));
  });

  it('AC-5: delivers one recovery email for an opted-in account through real notify', async () => {
    await db.notificationPreference.create({
      data: { userId, tenantId: 'default', channel: 'email', enabled: true },
    });

    await requestReset(userEmail);
    const row = await waitFor(async () => {
      const rows = await scheduleRows(userEmail);
      return rows.find((entry) => entry.status === 'SENT') ?? null;
    }, 'the opted-in reset schedule row to finish');

    expect(row).toMatchObject({ userId, toEmail: userEmail, status: 'SENT' });
    expect((sendOne.mock.calls[0] as unknown[])[3]).toBeNull();
    expect(providerSend).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('AC-6: ordinary notification email still respects the opted-out preference under SYSTEM/email', async () => {
    await db.notificationPreference.create({
      data: { userId, tenantId: 'default', channel: 'email', enabled: false },
    });

    await withTestActor({ type: 'SYSTEM', id: 'email' }, () => app.get<INotifyService>(NOTIFY_SERVICE).send({
      tenantId: 'default', channel: NotificationChannel.EMAIL, templateCode: 'NOTIFICATION', locale: 'en',
      recipient: userEmail, userId, data: {
        title: 'ordinary notice', body: '', url: 'https://koda.test', prefsUrl: 'https://koda.test/prefs',
      },
    }));

    expect(providerSend).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('AC-4: writes one PASSWORD_RESET schedule row for the user and ends it SENT', async () => {
    await requestReset(userEmail);

    const row = await waitFor(async () => {
      const rows = await scheduleRows(userEmail);
      return rows.find((entry) => entry.status === 'SENT') ?? null;
    }, 'the SENT schedule row');

    expect(row).toMatchObject({ kind: 'PASSWORD_RESET', userId, status: 'SENT' });
    expect(await scheduleRows(userEmail)).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('AC-5: a throwing email channel still answers 200 {} and ends the row FAILED, logged as a warning', async () => {
    providerSend.mockRejectedValue(new Error('smtp refused the connection'));

    const response = await requestReset(userEmail);
    expect(response.body).toEqual({ ret: 0, data: {} });

    const row = await waitFor(async () => {
      const rows = await scheduleRows(userEmail);
      return rows.find((entry) => entry.status === 'FAILED') ?? null;
    }, 'the FAILED schedule row');

    expect(row.kind).toBe('PASSWORD_RESET');
    // A warning that names this request's user, so a warning from any other test cannot satisfy it.
    expect(warn.mock.calls.some(([message]) => String(message).includes(userId))).toBe(true);
  });

  it('AC-6: an unknown address answers 200 {} and writes nothing across the full observation window', async () => {
    const unknown = `nobody-${randomUUID()}@example.test`;
    const response = await requestReset(unknown);
    expect(response.body).toEqual({ ret: 0, data: {} });

    // The specified wait, spent on the unknown address itself: it is watched for the whole bound the
    // positive cases allow the detached task, so a token or schedule row that landed late — a task that
    // should never have started — cannot slip past a short sleep.
    const startedAt = Date.now();
    const polls = await observeAbsence(async () => {
      const [users, tokens, schedules] = await Promise.all([
        db.user.count({ where: { email: unknown } }),
        db.passwordResetToken.count({ where: { user: { email: unknown } } }),
        db.emailSchedule.count({ where: { toEmail: unknown, kind: 'PASSWORD_RESET' } }),
      ]);
      const mailed = (send.mock.calls as unknown as [{ recipient?: string }][])
        .filter(([payload]) => payload.recipient === unknown).length;

      if (users > 0) return `${users} user row(s) for the address`;
      if (tokens > 0) return `${tokens} reset token row(s)`;
      if (schedules > 0) return `${schedules} schedule row(s)`;
      if (mailed > 0) return `${mailed} email(s)`;
      return null;
    }, 'the unknown address stayed untouched');

    // The window is the spec's bound, not a short sleep: prove it was actually observed for that long.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(WAIT_MS - 250);
    expect(polls).toBeGreaterThan(10);
    expect(await scheduleRows(unknown)).toEqual([]);
    expect(await db.user.count({ where: { email: unknown } })).toBe(0);
    expect((sendOne.mock.calls as unknown as [{ toEmail: string }][]).filter(([row]) => row.toEmail === unknown))
      .toEqual([]);
  });

  it('AC-7: a disabled user answers 200 {} and gets no token and no email', async () => {
    const disabledEmail = `${randomUUID()}@example.test`;
    const disabledId = await createUser(disabledEmail, true);

    await requestReset(disabledEmail);
    await sleep(250);

    expect(await tokenRows(disabledId)).toEqual([]);
    expect(await scheduleRows(disabledEmail)).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('AC-8: with email unconfigured it answers 200 {} and writes nothing', async () => {
    const configured = vi.spyOn(email, 'configured', 'get').mockReturnValue(false);

    await requestReset(userEmail);
    await sleep(250);
    configured.mockRestore();

    expect(await tokenRows(userId)).toEqual([]);
    expect(await scheduleRows(userEmail)).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('AC-9: known and unknown addresses answer the same body and neither is an unaudited write', async () => {
    const unknown = `nobody-${randomUUID()}@example.test`;

    const known = await requestReset(userEmail);
    const anonymous = await requestReset(unknown);

    expect(known.body).toEqual(anonymous.body);
    expect(known.body).toEqual({ ret: 0, data: {} });
    // Audit coverage runs in `throw` mode here, so an uncovered write would have answered 500.
    expect(known.text).not.toContain('unaudited write');
    expect(anonymous.text).not.toContain('unaudited write');
  });

  it('AC-10: a second request leaves exactly one unused token row', async () => {
    await requestReset(userEmail);
    await waitFor(async () => (await scheduleRows(userEmail)).length === 1, 'the first reset');
    await requestReset(userEmail);
    await waitFor(async () => (await scheduleRows(userEmail)).length === 2, 'the second reset');

    expect(await unusedRows(userId)).toHaveLength(1);
    expect(await tokenRows(userId)).toHaveLength(1);
  });

  it('AC-11: Accept-Language zh-CN writes locale zh and fr writes en', async () => {
    await requestReset(userEmail, 'zh-CN,zh;q=0.9');
    const chinese = await waitFor(async () => {
      const rows = await scheduleRows(userEmail);
      return rows.find((entry) => entry.locale === 'zh') ?? null;
    }, 'the zh schedule row');
    expect(chinese.locale).toBe('zh');

    const frenchEmail = `${randomUUID()}@example.test`;
    await createUser(frenchEmail);
    await requestReset(frenchEmail, 'fr-FR,fr;q=0.8');
    const english = await waitFor(async () => {
      const rows = await scheduleRows(frenchEmail);
      return rows.length > 0 ? rows[0] : null;
    }, 'the en schedule row');
    expect(english.locale).toBe('en');
  });

  it('AC-12: is throttled like login', async () => {
    for (let i = 0; i < AUTH_LOGIN_LIMIT; i += 1) await requestReset(userEmail);
    await requestReset(userEmail, undefined, 429);
  });

  it('AC-14: a successful password change deletes the outstanding reset token', async () => {
    await requestReset(userEmail);
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

  it('AC-15: a body that is not an email address answers localized 400 and writes nothing', async () => {
    const english = await requestReset('not-an-address', undefined, 400);
    expect(english.body.message).toBe('Must be a valid email address');

    const chinese = await requestReset('not-an-address', 'zh-CN', 400);
    expect(chinese.body.message).toBe('必须是有效的邮箱地址');
    expect(chinese.body.errors.email).toEqual(['必须是有效的邮箱地址']);
    expect(JSON.stringify(chinese.body)).not.toContain('$t(');

    expect(JSON.stringify(english.body)).not.toBe('{}');
    expect(await tokenRows(userId)).toEqual([]);
    expect(await scheduleRows('not-an-address')).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});

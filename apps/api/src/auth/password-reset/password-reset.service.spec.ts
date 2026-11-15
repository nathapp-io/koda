import { Logger } from '@nestjs/common';
import { currentBookkeepingReason } from '../../action-context/audit-coverage';
import type { EmailScheduleRow } from '../../email/schedule/email-schedule.types';
import { PASSWORD_RESET_TTL_MS } from './password-reset.constants';
import { hashPasswordResetToken } from './password-reset-token';
import { PasswordResetService } from './password-reset.service';

/**
 * auth-passwords US-003: the reset request's detached task, unit level.
 *
 * The service has no Nest lifecycle, so it is instantiated directly (api-testing rules). Every case
 * checks what the detached task writes; the HTTP surface is covered by the integration spec.
 */
describe('PasswordResetService', () => {
  const user = {
    id: 'user-1', email: 'user@example.test', name: 'User', passwordHash: 'hash',
    tokenVersion: 0, disabled: false, createdAt: new Date(), updatedAt: new Date(),
  };
  const row: EmailScheduleRow = {
    id: 'schedule-1', kind: 'PASSWORD_RESET', notificationId: null, inviteId: null, userId: user.id,
    projectId: null, toEmail: user.email, locale: 'en', attempts: 1, dueAt: new Date(),
  };

  let authRepo: { findUserByEmail: ReturnType<typeof vi.fn> };
  let tokens: { replaceUnused: ReturnType<typeof vi.fn> };
  let schedule: { startPasswordResetSend: ReturnType<typeof vi.fn> };
  let dispatcher: { sendOne: ReturnType<typeof vi.fn> };
  let email: { configured: boolean; webUrl: ReturnType<typeof vi.fn> };
  let warn: ReturnType<typeof vi.spyOn>;
  let service: PasswordResetService;

  const build = (): PasswordResetService =>
    new PasswordResetService(authRepo as never, tokens as never, schedule as never, dispatcher as never, email as never);

  /** The raw token the task generated, read back out of the url it emailed. */
  const emailedRawToken = (): string => {
    const [, , payload] = dispatcher.sendOne.mock.calls[0] as [EmailScheduleRow, string, { url: string }];
    return payload.url.slice(payload.url.lastIndexOf('/reset-password/') + '/reset-password/'.length);
  };

  beforeEach(() => {
    authRepo = { findUserByEmail: vi.fn(async () => user) };
    tokens = { replaceUnused: vi.fn(async () => undefined) };
    schedule = { startPasswordResetSend: vi.fn(async () => row) };
    dispatcher = { sendOne: vi.fn(async () => 'SENT') };
    email = { configured: true, webUrl: vi.fn((path: string) => `https://web.test${path}`) };
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    service = build();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AC-1: writes the token with a 30-minute expiry for the looked-up user', async () => {
    const before = Date.now();
    await service.request(user.email, 'en');
    await vi.waitFor(() => expect(tokens.replaceUnused).toHaveBeenCalledTimes(1));

    const [userId, tokenHash, expiresAt] = tokens.replaceUnused.mock.calls[0] as [string, string, Date];
    expect(userId).toBe(user.id);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(PASSWORD_RESET_TTL_MS - 1_000);
    expect(expiresAt.getTime() - before).toBeLessThanOrEqual(PASSWORD_RESET_TTL_MS + 1_000);
  });

  it('AC-2: stores the sha256 of the emailed token, never the raw token itself', async () => {
    await service.request(user.email, 'en');
    await vi.waitFor(() => expect(dispatcher.sendOne).toHaveBeenCalledTimes(1));

    const raw = emailedRawToken();
    const [, tokenHash] = tokens.replaceUnused.mock.calls[0] as [string, string];
    expect(tokenHash).toBe(hashPasswordResetToken(raw));
    expect(tokenHash).not.toBe(raw);
    expect(JSON.stringify(tokens.replaceUnused.mock.calls)).not.toContain(raw);
    expect(schedule.startPasswordResetSend.mock.calls[0][0]).not.toHaveProperty('rawToken');
  });

  it('AC-3: sends PASSWORD_RESET through sendOne with the web url and retry off', async () => {
    await service.request(user.email, 'en');
    await vi.waitFor(() => expect(dispatcher.sendOne).toHaveBeenCalledTimes(1));

    const [sentRow, templateCode, payload, recipient, now, retryable] = dispatcher.sendOne.mock.calls[0] as [
      EmailScheduleRow, string, { url: string; expiresAt: string }, string, Date, boolean,
    ];
    const raw = emailedRawToken();
    expect(sentRow).toBe(row);
    expect(templateCode).toBe('PASSWORD_RESET');
    expect(payload.url).toBe(`https://web.test/reset-password/${raw}`);
    expect(payload.expiresAt).toBe(new Date(payload.expiresAt).toISOString());
    expect(recipient).toBe(user.id);
    expect(now).toBeInstanceOf(Date);
    expect(retryable).toBe(false);
  });

  it('AC-4/AC-11: schedules one PASSWORD_RESET send for the user in the requested locale', async () => {
    await service.request(user.email, 'zh');
    await vi.waitFor(() => expect(schedule.startPasswordResetSend).toHaveBeenCalledTimes(1));

    expect(schedule.startPasswordResetSend).toHaveBeenCalledWith({
      userId: user.id, toEmail: user.email, locale: 'zh', now: expect.any(Date),
    });
  });

  it('AC-6: an unknown address writes nothing', async () => {
    authRepo.findUserByEmail.mockResolvedValueOnce(null);
    await service.request('nobody@example.test', 'en');
    await new Promise((resolve) => { setImmediate(resolve); });

    expect(tokens.replaceUnused).not.toHaveBeenCalled();
    expect(schedule.startPasswordResetSend).not.toHaveBeenCalled();
    expect(dispatcher.sendOne).not.toHaveBeenCalled();
  });

  it('AC-7: a disabled user writes nothing', async () => {
    authRepo.findUserByEmail.mockResolvedValueOnce({ ...user, disabled: true });
    await service.request(user.email, 'en');
    await new Promise((resolve) => { setImmediate(resolve); });

    expect(tokens.replaceUnused).not.toHaveBeenCalled();
    expect(dispatcher.sendOne).not.toHaveBeenCalled();
  });

  it('AC-8: an unconfigured email channel writes nothing', async () => {
    email.configured = false;
    await service.request(user.email, 'en');
    await new Promise((resolve) => { setImmediate(resolve); });

    expect(tokens.replaceUnused).not.toHaveBeenCalled();
    expect(dispatcher.sendOne).not.toHaveBeenCalled();
  });

  it('runs the whole task inside the auth.password-reset-request bookkeeping reason', async () => {
    const reasons: (string | undefined)[] = [];
    tokens.replaceUnused.mockImplementation(async () => { reasons.push(currentBookkeepingReason()); });
    schedule.startPasswordResetSend.mockImplementation(async () => { reasons.push(currentBookkeepingReason()); return row; });
    dispatcher.sendOne.mockImplementation(async () => { reasons.push(currentBookkeepingReason()); return 'SENT'; });

    await service.request(user.email, 'en');
    await vi.waitFor(() => expect(reasons).toHaveLength(3));

    expect(reasons).toEqual(['auth.password-reset-request', 'auth.password-reset-request', 'auth.password-reset-request']);
    expect(currentBookkeepingReason()).toBeUndefined();
  });

  it('answers before the detached task settles', async () => {
    let release!: () => void;
    tokens.replaceUnused.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));

    await expect(service.request(user.email, 'en')).resolves.toBeUndefined();
    expect(dispatcher.sendOne).not.toHaveBeenCalled();

    release();
    await vi.waitFor(() => expect(dispatcher.sendOne).toHaveBeenCalledTimes(1));
  });

  it('logs a rejected task as a warning and never rejects the request', async () => {
    tokens.replaceUnused.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(service.request(user.email, 'en')).resolves.toBeUndefined();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('database unavailable')));
    // Only the user id and the reason reach the log — never the token or the link.
    expect(JSON.stringify(warn.mock.calls)).not.toContain('/reset-password/');
    expect(dispatcher.sendOne).not.toHaveBeenCalled();
  });

  it('logs a FAILED send outcome as a warning', async () => {
    dispatcher.sendOne.mockResolvedValueOnce('FAILED');

    await service.request(user.email, 'en');
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('FAILED')));
  });
});

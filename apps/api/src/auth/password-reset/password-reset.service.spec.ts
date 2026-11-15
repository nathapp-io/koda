import { Logger } from '@nestjs/common';
import { currentBookkeepingReason } from '../../action-context/audit-coverage';
import type { EmailScheduleRow } from '../../email/schedule/email-schedule.types';
import {
  authSessionCacheKey,
  userAuthStateCacheKey,
  userTokenVersionCacheTag,
} from '../token-version.cache';
import { PASSWORD_RESET_TTL_MS } from './password-reset.constants';
import { hashPasswordResetToken } from './password-reset-token';
import { PasswordResetService } from './password-reset.service';

/**
 * A pass-through bcrypt mock.
 *
 * The service's compiled `import * as bcrypt` takes a snapshot of the module's exports, so a
 * `vi.spyOn(bcrypt, 'hash')` applied after the import never sees the service's own call. Replacing the
 * module keeps the real KDF running while making the call observable.
 */
const bcryptHash = vi.hoisted(() => vi.fn());
vi.mock('bcrypt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bcrypt')>();
  bcryptHash.mockImplementation(actual.hash as unknown as (password: string, rounds: number) => Promise<string>);
  return { ...actual, hash: bcryptHash, default: { ...actual, hash: bcryptHash } };
});

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

  const build = (): PasswordResetService => new PasswordResetService(
    authRepo as never, tokens as never, schedule as never, dispatcher as never, email as never,
    { audited: vi.fn(), record: vi.fn() } as never,
    { revokeAllForUser: vi.fn() } as never,
    { invalidate: vi.fn() } as never,
  );

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

/**
 * auth-passwords US-004: the confirm's transaction, its refusals and its post-commit evictions, unit
 * level. The route and the database are covered by the integration spec; every case here is about the
 * order and the shape of the calls the service makes.
 */
describe('PasswordResetService.confirm', () => {
  const RAW = 'raw-token-value';
  const HASH = hashPasswordResetToken(RAW);
  const NOW = new Date('2026-12-10T12:00:00.000Z');
  const user = { id: 'user-1', disabled: false };
  const liveRow = {
    id: 'reset-1', userId: user.id, expiresAt: new Date('2026-12-10T12:30:00.000Z'), usedAt: null, userDisabled: false,
  };

  let authRepo: { findUserByEmail: ReturnType<typeof vi.fn> };
  let tokens: {
    replaceUnused: ReturnType<typeof vi.fn>;
    findByHash: ReturnType<typeof vi.fn>;
    markUsed: ReturnType<typeof vi.fn>;
    discardUnusedFor: ReturnType<typeof vi.fn>;
  };
  let authSessions: { revokeAllForUser: ReturnType<typeof vi.fn> };
  let authRepoWrites: { lockUser: ReturnType<typeof vi.fn>; updatePasswordHash: ReturnType<typeof vi.fn>; bumpTokenVersion: ReturnType<typeof vi.fn> };
  let audit: { audited: ReturnType<typeof vi.fn>; record: ReturnType<typeof vi.fn> };
  let cache: { invalidate: ReturnType<typeof vi.fn> };
  let schedule: { startPasswordResetSend: ReturnType<typeof vi.fn> };
  let dispatcher: { sendOne: ReturnType<typeof vi.fn> };
  let email: { configured: boolean; webUrl: ReturnType<typeof vi.fn> };
  let service: PasswordResetService;

  const build = (): PasswordResetService => new PasswordResetService(
    authRepoWrites as never,
    tokens as never,
    schedule as never,
    dispatcher as never,
    email as never,
    audit as never,
    authSessions as never,
    cache as never,
  );

  beforeEach(() => {
    authRepo = { findUserByEmail: vi.fn(async () => user) };
    tokens = {
      replaceUnused: vi.fn(async () => undefined),
      findByHash: vi.fn(async () => liveRow),
      markUsed: vi.fn(async () => 1),
      discardUnusedFor: vi.fn(async () => 0),
    };
    authRepoWrites = {
      lockUser: vi.fn(async () => ({ passwordHash: 'stored-hash', disabled: false })),
      updatePasswordHash: vi.fn(async () => undefined),
      bumpTokenVersion: vi.fn(async () => 1),
    };
    authSessions = { revokeAllForUser: vi.fn(async () => ['s1', 's2']) };
    audit = { audited: vi.fn(<T>(fn: () => Promise<T>) => fn()), record: vi.fn(async () => undefined) };
    cache = { invalidate: vi.fn(async () => undefined) };
    schedule = { startPasswordResetSend: vi.fn() };
    dispatcher = { sendOne: vi.fn() };
    email = { configured: true, webUrl: vi.fn((path: string) => `https://web.test${path}`) };
    bcryptHash.mockClear();
    service = build();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The `audited` entry callback the service passed, read back as the audit recorder would read it. */
  const auditedEntry = (): Record<string, unknown> => {
    const [, entriesOf] = audit.audited.mock.calls[0] as [() => Promise<unknown>, (result: unknown) => unknown];
    return entriesOf(['s1', 's2']) as Record<string, unknown>;
  };

  it('AC-1: hashes the presented token, marks the row used and writes the new password in the audit transaction', async () => {
    await service.confirm({ token: RAW, newPassword: 'NewPassword123!' }, NOW);

    expect(tokens.findByHash).toHaveBeenCalledWith(HASH);
    expect(audit.audited).toHaveBeenCalledTimes(1);
    expect(tokens.markUsed).toHaveBeenCalledWith(liveRow.id, NOW);
    expect(authRepoWrites.updatePasswordHash).toHaveBeenCalledWith(user.id, expect.stringMatching(/^\$2[aby]\$/));
    expect(authRepoWrites.bumpTokenVersion).toHaveBeenCalledWith(user.id);
    expect(authSessions.revokeAllForUser).toHaveBeenCalledWith(user.id, 'password-reset', NOW);
    expect(tokens.discardUnusedFor).toHaveBeenCalledWith(user.id);
  });

  it('B2: locks the user row before touching any reset-token row', async () => {
    await service.confirm({ token: RAW, newPassword: 'NewPassword123!' }, NOW);

    // One lock order for every password write: user row first, reset-token rows after. Locking the token
    // first deadlocked against a concurrent reset request that held the user row while deleting tokens.
    expect(authRepoWrites.lockUser).toHaveBeenCalledWith(user.id);
    const order = (mock: { mock: { invocationCallOrder: number[] } }): number => mock.mock.invocationCallOrder[0];
    expect(order(authRepoWrites.lockUser)).toBeLessThan(order(tokens.markUsed));
    expect(order(authRepoWrites.lockUser)).toBeLessThan(order(tokens.discardUnusedFor));
    expect(order(authRepoWrites.lockUser)).toBeLessThan(order(authRepoWrites.updatePasswordHash));
  });

  it('AC-1: hashes the new password before opening the transaction', async () => {
    await service.confirm({ token: RAW, newPassword: 'NewPassword123!' }, NOW);

    expect(bcryptHash).toHaveBeenCalledTimes(1);
    expect(bcryptHash.mock.calls[0][0]).toBe('NewPassword123!');
    expect(bcryptHash.mock.calls[0][1]).toBe(12);
    // bcrypt resolved before `audited` was entered, so the transaction never spans the KDF.
    expect(bcryptHash.mock.invocationCallOrder[0]).toBeLessThan(audit.audited.mock.invocationCallOrder[0]);
  });

  it('AC-9: records session.password.reset.confirm for the user', async () => {
    await service.confirm({ token: RAW, newPassword: 'NewPassword123!' }, NOW);

    expect(auditedEntry()).toEqual({
      key: 'session.password.reset.confirm',
      resourceType: 'user',
      resourceId: user.id,
      projectId: null,
      summary: 'password reset',
    });
  });

  it('AC-2/AC-10: a row already used (markUsed answers 0) is the same 400 and rolls the transaction back', async () => {
    tokens.markUsed.mockResolvedValueOnce(0);

    await expect(service.confirm({ token: RAW, newPassword: 'NewPassword123!' }, NOW)).rejects.toMatchObject({
      prefix: 'auth.resetTokenInvalid', httpStatus: 400,
    });
    expect(authRepoWrites.updatePasswordHash).not.toHaveBeenCalled();
    expect(authRepoWrites.bumpTokenVersion).not.toHaveBeenCalled();
    expect(authSessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(tokens.discardUnusedFor).not.toHaveBeenCalled();
  });

  // Branch fix B2: the token row's own `userDisabled` is read before bcrypt, so a disable that commits
  // while the new hash is being computed is only visible under the user row lock.
  it.each([
    ['disabled under the lock', { passwordHash: 'stored-hash', disabled: true }],
    ['its user row gone under the lock', null],
  ])('B2: a user %s is the same 400, before any write', async (_label, locked) => {
    authRepoWrites.lockUser.mockResolvedValueOnce(locked);

    await expect(service.confirm({ token: RAW, newPassword: 'NewPassword123!' }, NOW)).rejects.toMatchObject({
      prefix: 'auth.resetTokenInvalid', httpStatus: 400,
    });
    expect(tokens.markUsed).not.toHaveBeenCalled();
    expect(authRepoWrites.updatePasswordHash).not.toHaveBeenCalled();
    expect(authRepoWrites.bumpTokenVersion).not.toHaveBeenCalled();
    expect(authSessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(cache.invalidate).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown token', null],
    ['a used row', { ...liveRow, usedAt: new Date('2026-12-10T11:00:00.000Z') }],
    ['an expired row', { ...liveRow, expiresAt: NOW }],
    ['a disabled user', { ...liveRow, userDisabled: true }],
  ])('AC-3/AC-4/AC-5: %s is 400 auth.resetTokenInvalid with nothing written', async (_label, row) => {
    tokens.findByHash.mockResolvedValueOnce(row);

    await expect(service.confirm({ token: RAW, newPassword: 'NewPassword123!' }, NOW)).rejects.toMatchObject({
      prefix: 'auth.resetTokenInvalid', httpStatus: 400,
    });
    expect(audit.audited).not.toHaveBeenCalled();
    expect(authRepoWrites.updatePasswordHash).not.toHaveBeenCalled();
    expect(cache.invalidate).not.toHaveBeenCalled();
  });

  it('AC-6: evicts every revoked session and the user caches after the commit', async () => {
    await service.confirm({ token: RAW, newPassword: 'NewPassword123!' }, NOW);

    expect(cache.invalidate.mock.calls).toEqual([
      [authSessionCacheKey('s1')],
      [authSessionCacheKey('s2')],
      [userTokenVersionCacheTag(user.id), { mode: 'tag' }],
      [userAuthStateCacheKey(user.id)],
    ]);
    // The evictions happen after the transaction closed, never inside it.
    expect(audit.audited.mock.invocationCallOrder[0])
      .toBeLessThan(cache.invalidate.mock.invocationCallOrder[0]);
  });

  it('AC-6: a failing cache eviction does not undo the committed reset, and every eviction is still attempted', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    cache.invalidate.mockRejectedValue(new Error('cache down'));

    await expect(service.confirm({ token: RAW, newPassword: 'NewPassword123!' }, NOW)).resolves.toBeUndefined();

    // Three sessions-plus-user answers, all attempted, each failure logged rather than thrown.
    expect(cache.invalidate).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(String(warn.mock.calls[0][0])).toContain('cache down');
  });

  it('AC-14: answers void — no session and no token pair', async () => {
    const result = await service.confirm({ token: RAW, newPassword: 'NewPassword123!' }, NOW);

    expect(result).toBeUndefined();
    expect(authSessions.revokeAllForUser).toHaveBeenCalled();
    expect(Object.keys(authSessions)).toEqual(['revokeAllForUser']);
  });
});

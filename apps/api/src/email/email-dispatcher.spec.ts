import { NotifyException, NotifyExceptionCode } from '@nathapp/nestjs-notify';
import { EmailDispatcher } from './email-dispatcher';
import { PermanentNotificationError } from './permanent-notification.error';
import type { EmailScheduleRow } from './schedule/email-schedule.types';

const NOW = new Date('2026-10-10T12:05:00.000Z');
const plusMin = (base: Date, minutes: number) => new Date(base.getTime() + minutes * 60_000);

const row = (over: Partial<EmailScheduleRow> = {}): EmailScheduleRow => ({
  id: 's1', kind: 'NOTIFICATION', notificationId: 'n1', inviteId: null, userId: 'u1', projectId: null,
  toEmail: 'a@example.com', locale: 'en', attempts: 1, dueAt: NOW, ...over,
});

function setup() {
  const schedule = {
    closeAbandonedInvites: jest.fn(async () => 0),
    claimDue: jest.fn(async () => [] as EmailScheduleRow[]),
    markSent: jest.fn(async () => undefined),
    markSkipped: jest.fn(async () => undefined),
    markFailed: jest.fn(async () => undefined),
    retryAt: jest.fn(async () => undefined),
  };
  const builder = { build: jest.fn() };
  const notify = { send: jest.fn(async (_req?: { recipient?: string }) => undefined) };
  const email = { configured: true, config: () => ({ maxAttempts: 5 }) };
  const dispatcher = new EmailDispatcher(schedule as never, builder as never, notify as never, email as never);
  const logger = (dispatcher as unknown as { logger: { warn: jest.Mock } }).logger;
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  return { dispatcher, schedule, builder, notify, email, warn };
}

/** RED-friendly tick: resolves to undefined only when the dispatcher actually runs. */
const tick = (dispatcher: EmailDispatcher, at: Date) => expect(dispatcher.tick(at)).resolves.toBeUndefined();

describe('EmailDispatcher (S4b US-002)', () => {
  it('closes abandoned invite sends, claims due rows, and skips a SOURCE_GONE row (AC21)', async () => {
    const { dispatcher, schedule, builder, notify } = setup();
    schedule.claimDue.mockResolvedValue([row()]);
    builder.build.mockResolvedValue({ skip: 'SOURCE_GONE' });
    await tick(dispatcher, NOW);
    expect(schedule.closeAbandonedInvites).toHaveBeenCalledWith(NOW);
    expect(schedule.claimDue).toHaveBeenCalledWith(NOW, expect.any(Number));
    expect(schedule.markSkipped).toHaveBeenCalledWith('s1', 'SOURCE_GONE');
    expect(notify.send).not.toHaveBeenCalled();
  });

  it('records USER_DISABLED as the skip reason (AC22)', async () => {
    const { dispatcher, schedule, builder, notify } = setup();
    schedule.claimDue.mockResolvedValue([row()]);
    builder.build.mockResolvedValue({ skip: 'USER_DISABLED' });
    await tick(dispatcher, NOW);
    expect(schedule.markSkipped).toHaveBeenCalledWith('s1', 'USER_DISABLED');
    expect(notify.send).not.toHaveBeenCalled();
  });

  it('records the emailAllowed reason verbatim as the skip reason (AC23)', async () => {
    const { dispatcher, schedule, builder } = setup();
    schedule.claimDue.mockResolvedValue([row()]);
    builder.build.mockResolvedValue({ skip: 'CATEGORY_OFF' });
    await tick(dispatcher, NOW);
    expect(schedule.markSkipped).toHaveBeenCalledWith('s1', 'CATEGORY_OFF');
  });

  it('sends an allowed row with the exact notify envelope and marks it SENT (AC24)', async () => {
    const { dispatcher, schedule, builder, notify } = setup();
    schedule.claimDue.mockResolvedValue([row({ kind: 'NOTIFICATION', toEmail: 'b@example.com', locale: 'en' })]);
    builder.build.mockResolvedValue({ data: { title: 'T', body: 'B', url: 'https://web/l', prefsUrl: 'https://web/settings/notifications' }, userId: 'u1' });
    await tick(dispatcher, NOW);
    expect(notify.send).toHaveBeenCalledTimes(1);
    expect(notify.send).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'default',
      channel: 'email',
      templateCode: 'NOTIFICATION',
      locale: 'en',
      recipient: 'b@example.com',
      data: { title: 'T', body: 'B', url: 'https://web/l', prefsUrl: 'https://web/settings/notifications' },
    }));
    expect(schedule.markSent).toHaveBeenCalledWith('s1', NOW);
    expect(schedule.markFailed).not.toHaveBeenCalled();
  });

  it('backs off a transient failure at attempts 3 to now + 4 minutes and keeps lastError (AC25)', async () => {
    const { dispatcher, schedule, builder, notify } = setup();
    schedule.claimDue.mockResolvedValue([row({ attempts: 3 })]);
    builder.build.mockResolvedValue({ data: { title: 'T' }, userId: 'u1' });
    notify.send.mockRejectedValueOnce(new Error('transport down'));
    await tick(dispatcher, NOW);
    expect(schedule.retryAt).toHaveBeenCalledWith('s1', plusMin(NOW, 4), 'transport down');
    expect(schedule.markFailed).not.toHaveBeenCalled();
  });

  it('one failing row does not stop the rest of the batch (AC25)', async () => {
    const { dispatcher, schedule, builder, notify } = setup();
    const a = row({ id: 'a' });
    const b = row({ id: 'b', toEmail: 'b@example.com' });
    schedule.claimDue.mockResolvedValue([a, b]);
    builder.build.mockResolvedValue({ data: { title: 'T' }, userId: 'u1' });
    notify.send.mockImplementation(async (req: { recipient: string }) => {
      if (req.recipient === 'a@example.com') throw new Error('transport down');
    });
    await tick(dispatcher, NOW);
    expect(schedule.retryAt).toHaveBeenCalledWith('a', plusMin(NOW, 2), 'transport down');
    expect(schedule.markSent).toHaveBeenCalledWith('b', NOW);
  });

  it('marks the row FAILED at EMAIL_MAX_ATTEMPTS and logs only id, kind and attempts (AC26)', async () => {
    const { dispatcher, schedule, builder, notify, warn } = setup();
    schedule.claimDue.mockResolvedValue([row({ id: 's-max', kind: 'NOTIFICATION', toEmail: 'secret@example.com', attempts: 5 })]);
    builder.build.mockResolvedValue({ data: { title: 'SecretTitle', body: 'SecretBody', url: 'https://web/secret' }, userId: 'u1' });
    notify.send.mockRejectedValueOnce(new Error('transport down'));
    await tick(dispatcher, NOW);
    expect(schedule.markFailed).toHaveBeenCalledWith('s-max', 'transport down');
    expect(schedule.retryAt).not.toHaveBeenCalled();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('s-max');
    expect(logged).toContain('NOTIFICATION');
    expect(logged).toContain('5');
    expect(logged).not.toContain('secret@example.com');
    expect(logged).not.toContain('SecretTitle');
    expect(logged).not.toContain('https://web/secret');
  });

  it('marks a PermanentNotificationError row FAILED on the first attempt (AC27)', async () => {
    const { dispatcher, schedule, builder, notify } = setup();
    schedule.claimDue.mockResolvedValue([row({ attempts: 1 })]);
    builder.build.mockResolvedValue({ data: { title: 'T' }, userId: 'u1' });
    notify.send.mockRejectedValueOnce(new PermanentNotificationError('invalid template'));
    await tick(dispatcher, NOW);
    expect(schedule.markFailed).toHaveBeenCalledWith('s1', expect.stringContaining('invalid template'));
    expect(schedule.retryAt).not.toHaveBeenCalled();
  });

  it('marks a TEMPLATE_NOT_FOUND NotifyException FAILED on the first attempt (AC27)', async () => {
    const { dispatcher, schedule, builder, notify } = setup();
    schedule.claimDue.mockResolvedValue([row({ attempts: 1 })]);
    builder.build.mockResolvedValue({ data: { title: 'T' }, userId: 'u1' });
    notify.send.mockRejectedValueOnce(new NotifyException(NotifyExceptionCode.TEMPLATE_NOT_FOUND));
    await tick(dispatcher, NOW);
    expect(schedule.markFailed).toHaveBeenCalled();
    expect(schedule.retryAt).not.toHaveBeenCalled();
  });

  it('US-002 AC10: a transient failure at attempts 2 with EMAIL_MAX_ATTEMPTS 5 retries at now + 2 minutes', async () => {
    const { dispatcher, schedule, builder, notify } = setup();
    schedule.claimDue.mockResolvedValue([row({ attempts: 2 })]);
    builder.build.mockResolvedValue({ data: { title: 'T' }, userId: 'u1' });
    notify.send.mockRejectedValueOnce(new Error('transport down'));
    await tick(dispatcher, NOW);
    expect(schedule.retryAt).toHaveBeenCalledWith('s1', plusMin(NOW, 2), 'transport down');
    expect(schedule.markFailed).not.toHaveBeenCalled();
  });

  it('does not resend an already SENT row on a second tick (AC29)', async () => {
    const { dispatcher, schedule, builder, notify } = setup();
    schedule.claimDue.mockResolvedValueOnce([row()]).mockResolvedValueOnce([]);
    builder.build.mockResolvedValue({ data: { title: 'T' }, userId: 'u1' });
    await tick(dispatcher, NOW);
    expect(notify.send).toHaveBeenCalledTimes(1);
    await tick(dispatcher, plusMin(NOW, 1));
    expect(notify.send).toHaveBeenCalledTimes(1);
  });
});

describe('EmailDispatcher scheduled ticks (S4b US-002)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts a ~30 second interval on init and stops it on destroy', async () => {
    jest.useFakeTimers();
    const { dispatcher, schedule } = setup();
    dispatcher.onModuleInit();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(schedule.claimDue).toHaveBeenCalledTimes(1);
    dispatcher.onModuleDestroy();
    schedule.claimDue.mockClear();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(schedule.claimDue).not.toHaveBeenCalled();
  });

  it('a scheduled tick that is still running suppresses the next one (no overlap)', async () => {
    const { dispatcher, schedule } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    schedule.claimDue.mockImplementation(async () => { await gate; return []; });
    const first = dispatcher.runScheduledTick(NOW);
    await dispatcher.runScheduledTick(NOW);
    expect(schedule.claimDue).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it('logs a failed scheduled tick instead of throwing it', async () => {
    const { dispatcher, schedule } = setup();
    schedule.closeAbandonedInvites.mockRejectedValueOnce(new Error('db down'));
    await expect(dispatcher.runScheduledTick(NOW)).resolves.toBeUndefined();
  });
});

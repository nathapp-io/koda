import { EmailContentBuilder } from './email-content.builder';
import type { EmailScheduleRow } from './schedule/email-schedule.types';

const WEB = 'https://koda.example.com';

const row = (over: Partial<EmailScheduleRow> = {}): EmailScheduleRow => ({
  id: 's1', kind: 'NOTIFICATION', notificationId: 'n1', inviteId: null, userId: 'u1', projectId: null,
  toEmail: 'a@example.com', locale: 'en', attempts: 1, dueAt: new Date('2026-10-10T12:05:00Z'), ...over,
});

function setup() {
  const notification = { findUnique: jest.fn(), findFirst: jest.fn() };
  const user = { findUnique: jest.fn(), findFirst: jest.fn() };
  const preferences = { emailAllowed: jest.fn(async (): Promise<{ allowed: boolean; reason?: string }> => ({ allowed: true })) };
  const email = { configured: true, webUrl: jest.fn((path: string) => `${WEB}${path}`) };
  const builder = new EmailContentBuilder(
    { client: { notification, user } } as never,
    preferences as never,
    email as never,
  );
  const setNotification = (value: unknown) => {
    notification.findUnique.mockResolvedValue(value);
    notification.findFirst.mockResolvedValue(value);
  };
  const setUser = (value: unknown) => {
    user.findUnique.mockResolvedValue(value);
    user.findFirst.mockResolvedValue(value);
  };
  return { builder, notification, user, preferences, email, setNotification, setUser };
}

describe('EmailContentBuilder (S4b US-002)', () => {
  it('US-002 AC21: a missing notification yields skip SOURCE_GONE', async () => {
    const { builder, setNotification, preferences } = setup();
    setNotification(null);
    await expect(builder.build(row())).resolves.toEqual({ skip: 'SOURCE_GONE' });
    expect(preferences.emailAllowed).not.toHaveBeenCalled();
  });

  it('US-002 AC21: a read notification yields skip READ and never consults preferences', async () => {
    const { builder, setNotification, preferences } = setup();
    setNotification({ id: 'n1', readAt: new Date(), category: 'ASSIGNED', title: 'T', body: null, link: '/l' });
    await expect(builder.build(row())).resolves.toEqual({ skip: 'READ' });
    expect(preferences.emailAllowed).not.toHaveBeenCalled();
  });

  it('US-002 AC22: a missing user yields skip USER_DISABLED without sending', async () => {
    const { builder, setNotification, setUser } = setup();
    setNotification({ id: 'n1', readAt: null, category: 'ASSIGNED', title: 'T', body: null, link: '/l' });
    setUser(null);
    await expect(builder.build(row())).resolves.toEqual({ skip: 'USER_DISABLED' });
  });

  it('US-002 AC22: a disabled user yields skip USER_DISABLED', async () => {
    const { builder, setNotification, setUser } = setup();
    setNotification({ id: 'n1', readAt: null, category: 'ASSIGNED', title: 'T', body: null, link: '/l' });
    setUser({ id: 'u1', disabled: true });
    await expect(builder.build(row())).resolves.toEqual({ skip: 'USER_DISABLED' });
  });

  it('US-002 AC23: an emailAllowed rejection is recorded verbatim as the skip reason', async () => {
    const { builder, setNotification, setUser, preferences } = setup();
    setNotification({ id: 'n1', readAt: null, category: 'ASSIGNED', title: 'T', body: null, link: '/l' });
    setUser({ id: 'u1', disabled: false });
    preferences.emailAllowed.mockResolvedValue({ allowed: false, reason: 'CATEGORY_OFF' });
    await expect(builder.build(row())).resolves.toEqual({ skip: 'CATEGORY_OFF' });
    preferences.emailAllowed.mockResolvedValue({ allowed: false, reason: 'EMAIL_OFF' });
    await expect(builder.build(row())).resolves.toEqual({ skip: 'EMAIL_OFF' });
  });

  it('US-002 AC24: an allowed row yields title, body, absolute url and prefsUrl with the user id', async () => {
    const { builder, setNotification, setUser, preferences, email } = setup();
    setNotification({ id: 'n1', readAt: null, category: 'ASSIGNED', title: 'Assigned', body: 'You were assigned', link: '/p/tickets/PP-1' });
    setUser({ id: 'u1', disabled: false });
    await expect(builder.build(row())).resolves.toEqual({
      data: {
        title: 'Assigned',
        body: 'You were assigned',
        url: `${WEB}/p/tickets/PP-1`,
        prefsUrl: `${WEB}/settings/notifications`,
      },
      userId: 'u1',
    });
    expect(preferences.emailAllowed).toHaveBeenCalledWith('u1', 'ASSIGNED');
    expect(email.webUrl).toHaveBeenCalledWith('/p/tickets/PP-1');
    expect(email.webUrl).toHaveBeenCalledWith('/settings/notifications');
  });

  it('US-002: a null body becomes an empty string in the template data', async () => {
    const { builder, setNotification, setUser } = setup();
    setNotification({ id: 'n1', readAt: null, category: 'ASSIGNED', title: 'T', body: null, link: '/l' });
    setUser({ id: 'u1', disabled: false });
    await expect(builder.build(row())).resolves.toHaveProperty('data.body', '');
  });
});

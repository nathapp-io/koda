import { EMAIL_CATEGORY_DEFAULTS } from './notification.types';
import { NotificationPreferencesService, PreferencesView } from './notification-preferences.service';

interface Row {
  userId: string;
  tenantId?: string;
  category?: string;
  channel?: string;
  enabled?: boolean;
}

/** Minimal filter over the fake rows: handles a scalar and a Prisma `{ in: [...] }` equality. */
function matchWhere(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = (row as unknown as Record<string, unknown>)[key];
    if (condition !== null && typeof condition === 'object' && 'in' in (condition as Record<string, unknown>)) {
      return (condition as { in: readonly unknown[] }).in.includes(value);
    }
    return value === condition;
  });
}

function setup(rows: { master?: Row[]; category?: Row[] } = {}) {
  const masterRows = rows.master ?? [];
  const categoryRows = rows.category ?? [];
  const notificationCategoryPreference = {
    findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => categoryRows.filter((r) => matchWhere(r, where))),
    upsert: jest.fn().mockResolvedValue({}),
  };
  const notificationPreference = {
    findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => masterRows.filter((r) => matchWhere(r, where))),
  };
  const txManager = { run: jest.fn((fn: () => Promise<unknown>) => fn()), getClient: jest.fn(), isInTransaction: jest.fn(() => false) };
  const packagePrefs = {
    getPreferences: jest.fn(async () => []),
    updatePreference: jest.fn(async () => ({})),
    isChannelEnabled: jest.fn(async () => true),
  };
  const email = { configured: true };
  const service = new NotificationPreferencesService(
    { client: { notificationCategoryPreference, notificationPreference } } as never,
    txManager as never,
    packagePrefs as never,
    email as never,
  );
  return { service, notificationCategoryPreference, notificationPreference, packagePrefs, txManager, email };
}

const emailsOf = (view: PreferencesView): Record<string, boolean> =>
  Object.fromEntries(view.items.map((item) => [item.category, item.email]));

describe('NotificationPreferencesService (S4a §2.1, D503)', () => {
  it('returns the users who switched the category off on the channel', async () => {
    const { service, notificationCategoryPreference } = setup({ category: [{ userId: 'u2', category: 'WATCHED_ACTIVITY', channel: 'in_app', enabled: false }] });
    const off = await service.disabledUserIds(['u1', 'u2'], 'WATCHED_ACTIVITY', 'in_app');
    expect([...off]).toEqual(['u2']);
    expect(notificationCategoryPreference.findMany).toHaveBeenCalledWith({
      where: { userId: { in: ['u1', 'u2'] }, category: 'WATCHED_ACTIVITY', channel: 'in_app', enabled: false },
      select: { userId: true },
    });
  });

  it('asks nothing for no users', async () => {
    const { service, notificationCategoryPreference } = setup();
    expect((await service.disabledUserIds([], 'ASSIGNED', 'in_app')).size).toBe(0);
    expect(notificationCategoryPreference.findMany).not.toHaveBeenCalled();
  });

  it('propagates a read failure instead of defaulting to on (spec §6)', async () => {
    const { service, notificationCategoryPreference } = setup();
    notificationCategoryPreference.findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(service.disabledUserIds(['u1'], 'ASSIGNED', 'in_app')).rejects.toThrow('db down');
  });
});

describe('NotificationPreferencesService (US-001 two-layer email preferences)', () => {
  it('US-001 AC8: list defaults email per category for a user with no preference rows', async () => {
    const { service } = setup();
    const view = await service.list('u1');
    expect(view.emailEnabled).toBe(true);
    expect(emailsOf(view)).toEqual({
      ASSIGNED: true,
      MENTIONED: true,
      WATCHED_ACTIVITY: false,
      FLEET_NEEDS_YOU: true,
      FLEET_HEALTH: false,
    });
    expect(emailsOf(view)).toEqual({ ...EMAIL_CATEGORY_DEFAULTS });
    expect(view.items).toHaveLength(5);
    expect(view.items.every((item) => item.inApp)).toBe(true);
  });

  it('US-001 AC8: list keeps an explicit category email row over the default', async () => {
    const { service } = setup({ category: [{ userId: 'u1', category: 'WATCHED_ACTIVITY', channel: 'email', enabled: true }, { userId: 'u1', category: 'ASSIGNED', channel: 'email', enabled: false }] });
    const view = await service.list('u1');
    expect(emailsOf(view)).toEqual(expect.objectContaining({ WATCHED_ACTIVITY: true, ASSIGNED: false, FLEET_HEALTH: false }));
  });

  it('US-001 AC9: list reports emailAvailable from EmailAvailability.configured', async () => {
    const { service, email } = setup();
    email.configured = false;
    await expect(service.list('u1')).resolves.toEqual(expect.objectContaining({ emailAvailable: false }));
    email.configured = true;
    await expect(service.list('u1')).resolves.toEqual(expect.objectContaining({ emailAvailable: true }));
  });

  it('US-001 AC10: emailAllowedUserIds drops a user whose master email switch is off', async () => {
    const { service } = setup({ master: [{ userId: 'off', tenantId: 'default', channel: 'email', enabled: false }] });
    const allowed = await service.emailAllowedUserIds(['off', 'plain'], 'ASSIGNED');
    expect([...allowed]).toEqual(['plain']);
  });

  it('US-001 AC11: emailAllowedUserIds keeps an opt-in watched-activity user', async () => {
    const { service } = setup({ category: [{ userId: 'opt-in', category: 'WATCHED_ACTIVITY', channel: 'email', enabled: true }] });
    const allowed = await service.emailAllowedUserIds(['opt-in'], 'WATCHED_ACTIVITY');
    expect([...allowed]).toEqual(['opt-in']);
  });

  it('US-001 AC12: emailAllowed reports EMAIL_OFF when the master switch is off', async () => {
    const { service } = setup({ master: [{ userId: 'off', tenantId: 'default', channel: 'email', enabled: false }] });
    await expect(service.emailAllowed('off', 'ASSIGNED')).resolves.toEqual({ allowed: false, reason: 'EMAIL_OFF' });
  });

  it('US-001 AC13: emailAllowed reports CATEGORY_OFF when the category email switch is off', async () => {
    const { service } = setup({ category: [{ userId: 'u', category: 'ASSIGNED', channel: 'email', enabled: false }] });
    await expect(service.emailAllowed('u', 'ASSIGNED')).resolves.toEqual({ allowed: false, reason: 'CATEGORY_OFF' });
  });

  it('US-001: emailAllowed allows when master and category are both on', async () => {
    const { service } = setup();
    await expect(service.emailAllowed('u', 'MENTIONED')).resolves.toEqual({ allowed: true });
  });

  it('US-001 AC14: update writes the email master switch through the package preference service', async () => {
    const { service, packagePrefs } = setup();
    await service.update('u1', { emailEnabled: false });
    expect(packagePrefs.updatePreference).toHaveBeenCalledWith('u1', 'default', 'email', false);
  });

  it('US-001 AC15: update with only an email field leaves the inApp value unchanged', async () => {
    const { service, notificationCategoryPreference } = setup();
    await service.update('u1', { items: [{ category: 'MENTIONED', email: false }] });
    expect(notificationCategoryPreference.upsert).toHaveBeenCalledTimes(1);
    expect(notificationCategoryPreference.upsert).toHaveBeenCalledWith({
      where: { userId_category_channel: { userId: 'u1', category: 'MENTIONED', channel: 'email' } },
      create: { userId: 'u1', category: 'MENTIONED', channel: 'email', enabled: false },
      update: { enabled: false },
    });
    expect(notificationCategoryPreference.upsert.mock.calls.some(([arg]) => arg.where.userId_category_channel.channel === 'in_app')).toBe(false);
  });

  it('US-001: update writes only the in-app channel when only inApp is supplied', async () => {
    const { service, notificationCategoryPreference } = setup();
    await service.update('u1', { items: [{ category: 'ASSIGNED', inApp: false }] });
    expect(notificationCategoryPreference.upsert).toHaveBeenCalledTimes(1);
    expect(notificationCategoryPreference.upsert).toHaveBeenCalledWith({
      where: { userId_category_channel: { userId: 'u1', category: 'ASSIGNED', channel: 'in_app' } },
      create: { userId: 'u1', category: 'ASSIGNED', channel: 'in_app', enabled: false },
      update: { enabled: false },
    });
  });
});

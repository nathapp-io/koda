import { NotificationPreferencesService } from './notification-preferences.service';

function setup(rows: Array<{ userId?: string; category?: string; enabled?: boolean }> = []) {
  const notificationPreference = {
    findMany: jest.fn().mockResolvedValue(rows),
    upsert: jest.fn().mockResolvedValue({}),
  };
  const txManager = { run: jest.fn((fn: () => Promise<unknown>) => fn()), getClient: jest.fn(), isInTransaction: jest.fn(() => false) };
  const service = new NotificationPreferencesService({ client: { notificationPreference } } as never, txManager as never);
  return { service, notificationPreference, txManager };
}

describe('NotificationPreferencesService (S4a §2.1, D503)', () => {
  it('returns the users who switched the category off on the channel', async () => {
    const { service, notificationPreference } = setup([{ userId: 'u2' }]);
    const off = await service.disabledUserIds(['u1', 'u2'], 'WATCHED_ACTIVITY', 'IN_APP');
    expect([...off]).toEqual(['u2']);
    expect(notificationPreference.findMany).toHaveBeenCalledWith({
      where: { userId: { in: ['u1', 'u2'] }, category: 'WATCHED_ACTIVITY', channel: 'IN_APP', enabled: false },
      select: { userId: true },
    });
  });

  it('asks nothing for no users', async () => {
    const { service, notificationPreference } = setup();
    expect((await service.disabledUserIds([], 'ASSIGNED', 'IN_APP')).size).toBe(0);
    expect(notificationPreference.findMany).not.toHaveBeenCalled();
  });

  it('lists all five categories, defaulting to on', async () => {
    const { service } = setup([{ category: 'FLEET_HEALTH', enabled: false }]);
    await expect(service.list('u1')).resolves.toEqual([
      { category: 'ASSIGNED', inApp: true },
      { category: 'MENTIONED', inApp: true },
      { category: 'WATCHED_ACTIVITY', inApp: true },
      { category: 'FLEET_NEEDS_YOU', inApp: true },
      { category: 'FLEET_HEALTH', inApp: false },
    ]);
  });

  it('upserts the IN_APP rows in one transaction', async () => {
    const { service, notificationPreference, txManager } = setup();
    await service.update('u1', [{ category: 'ASSIGNED', inApp: false }, { category: 'FLEET_HEALTH', inApp: true }]);
    expect(txManager.run).toHaveBeenCalledTimes(1);
    expect(notificationPreference.upsert).toHaveBeenCalledWith({
      where: { userId_category_channel: { userId: 'u1', category: 'ASSIGNED', channel: 'IN_APP' } },
      create: { userId: 'u1', category: 'ASSIGNED', channel: 'IN_APP', enabled: false },
      update: { enabled: false },
    });
    expect(notificationPreference.upsert).toHaveBeenCalledTimes(2);
  });

  it('propagates a read failure instead of defaulting to on (spec §6)', async () => {
    const { service, notificationPreference } = setup();
    notificationPreference.findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(service.disabledUserIds(['u1'], 'ASSIGNED', 'IN_APP')).rejects.toThrow('db down');
  });
});

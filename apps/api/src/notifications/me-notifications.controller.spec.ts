import { ForbiddenAppException } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { MeNotificationsController } from './me-notifications.controller';

const user: KodaPrincipal = {
  actorType: 'user', id: 'u1', sub: 'u1', role: 'MEMBER', email: 'u1@k.t', name: 'u1', blacklisted: false, revoked: false, authorities: [],
};
const agent: KodaPrincipal = {
  actorType: 'agent', id: 'a1', sub: 'a1', slug: 'bot', status: 'ACTIVE', agentRoles: [], capabilities: [],
  name: 'bot', blacklisted: false, revoked: false, authorities: [],
};

function setup() {
  const service = {
    list: jest.fn().mockResolvedValue({ total: 0, current: 1, size: 20, hasNext: false, hasPrev: false, records: [] }),
    unreadCount: jest.fn().mockResolvedValue({ count: 0 }),
    markRead: jest.fn().mockResolvedValue(undefined),
    markAllRead: jest.fn().mockResolvedValue(undefined),
  };
  const preferences = {
    list: jest.fn().mockResolvedValue([{ category: 'ASSIGNED', inApp: true }]),
    update: jest.fn().mockResolvedValue(undefined),
  };
  return { service, preferences, controller: new MeNotificationsController(service as never, preferences as never) };
}

describe('MeNotificationsController (S4a §3)', () => {
  it('refuses agents on every route (403)', async () => {
    const { controller } = setup();
    await expect(controller.list({}, agent)).rejects.toBeInstanceOf(ForbiddenAppException);
    await expect(controller.unreadCount(agent)).rejects.toBeInstanceOf(ForbiddenAppException);
    await expect(controller.markRead('n1', agent)).rejects.toBeInstanceOf(ForbiddenAppException);
    await expect(controller.markAllRead(agent)).rejects.toBeInstanceOf(ForbiddenAppException);
    await expect(controller.getPreferences(agent)).rejects.toBeInstanceOf(ForbiddenAppException);
    await expect(controller.updatePreferences({ items: [] }, agent)).rejects.toBeInstanceOf(ForbiddenAppException);
  });

  it('lists the caller\'s page with defaults and the unread filter', async () => {
    const { controller, service } = setup();
    await controller.list({}, user);
    expect(service.list).toHaveBeenCalledWith('u1', { current: 1, size: 20, unreadOnly: false });
    await controller.list({ current: '2', size: '5', unread: 'true' } as never, user);
    expect(service.list).toHaveBeenLastCalledWith('u1', { current: 2, size: 5, unreadOnly: true });
  });

  it('read-all cutoff: uses the request time, captured before the update runs (Review Focus 5)', async () => {
    const { controller, service } = setup();
    const before = Date.now();
    await controller.markAllRead(user);
    const cutoff = service.markAllRead.mock.calls[0][1] as Date;
    expect(service.markAllRead.mock.calls[0][0]).toBe('u1');
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before);
    expect(cutoff.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('reads and writes the caller\'s preferences', async () => {
    const { controller, preferences } = setup();
    const res = await controller.updatePreferences({ items: [{ category: 'FLEET_HEALTH', inApp: false }] }, user);
    expect(preferences.update).toHaveBeenCalledWith('u1', [{ category: 'FLEET_HEALTH', inApp: false }]);
    expect(res).toEqual(expect.objectContaining({ data: { items: [{ category: 'ASSIGNED', inApp: true }] } }));
  });
});

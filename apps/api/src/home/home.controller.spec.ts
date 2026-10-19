import { ForbiddenAppException } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { REQUIRES_METADATA } from '../permissions/requires.decorator';
import { HomeController } from './home.controller';

const user: KodaPrincipal = {
  actorType: 'user', id: 'u1', sub: 'u1', role: 'MEMBER', email: 'u1@k.t', name: 'u1',
  blacklisted: false, revoked: false, authorities: [],
} as KodaPrincipal;

const agent: KodaPrincipal = {
  actorType: 'agent', id: 'a1', sub: 'a1', slug: 'bot', status: 'ACTIVE', agentRoles: [], capabilities: [],
  name: 'bot', blacklisted: false, revoked: false, authorities: [],
} as KodaPrincipal;

const snapshot = { projects: [], assigned: [], activity: [] };

function setup() {
  const home = { snapshot: vi.fn().mockResolvedValue(snapshot) };
  return { home, controller: new HomeController(home as never) };
}

describe('US-010 permission key on the home route', () => {
  it('GET /home declares the implicit key home.read', () => {
    const fn = (HomeController.prototype as unknown as Record<string, object>)['get'];

    expect(Reflect.getMetadata(REQUIRES_METADATA, fn)).toEqual({
      keys: ['home.read'],
      mode: 'all',
      enforcedBy: 'guard',
    });
  });
});

describe('HomeController', () => {
  it('returns the caller\'s dashboard and forwards their global-admin flag', async () => {
    const { controller, home } = setup();

    const res = await controller.get(user);

    expect(home.snapshot).toHaveBeenCalledWith({ id: 'u1', globalAdmin: false }, expect.any(Date));
    expect(res).toEqual(expect.objectContaining({ data: snapshot }));
  });

  it('refuses an agent (403), which the implicit key alone would let through', async () => {
    const { controller } = setup();

    await expect(controller.get(agent)).rejects.toBeInstanceOf(ForbiddenAppException);
  });
});

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

function setup(projectRead = false) {
  const home = { snapshot: vi.fn().mockResolvedValue(snapshot) };
  // Permissions P1 (US-002): the dashboard's `globalAdmin` is the `project.read` key, asked globally.
  const permissions = {
    can: vi.fn(async () => ({
      allowed: projectRead,
      reason: projectRead ? 'granted' : 'not-granted',
    })),
  };
  return { home, permissions, controller: new HomeController(home as never, permissions as never) };
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

  // Permissions P1 (US-002): the dashboard scope is the `project.read` key, not the `role` claim.
  it('AC-4: a MEMBER-role user holding project.read globally gets globalAdmin true', async () => {
    const { controller, home, permissions } = setup(true);

    const res = await controller.get(user);

    expect(permissions.can).toHaveBeenCalledWith(user, 'project.read');
    expect(home.snapshot).toHaveBeenCalledWith({ id: 'u1', globalAdmin: true }, expect.any(Date));
    expect(res).toEqual(expect.objectContaining({ data: snapshot }));
  });

  it('AC-5: an ADMIN-role user whose project.read is refused gets globalAdmin false', async () => {
    const admin = { ...user, id: 'u2', sub: 'u2', role: 'ADMIN', email: 'u2@k.t', name: 'u2' } as KodaPrincipal;
    // The claim says ADMIN; the key says no. The key decides.
    const { controller, home } = setup(false);

    await controller.get(admin);

    expect(home.snapshot).toHaveBeenCalledWith({ id: 'u2', globalAdmin: false }, expect.any(Date));
  });
});

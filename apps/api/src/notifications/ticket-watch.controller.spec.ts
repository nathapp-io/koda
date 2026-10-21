import { ForbiddenAppException } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import type { ProjectContext } from '../projects/project-context';
import { PERMISSION_KEY } from '@nathapp/nestjs-auth';
import { REQUIRES_METADATA } from '../permissions/requires.decorator';
import { TicketWatchController } from './ticket-watch.controller';

const user: KodaPrincipal = {
  actorType: 'user', id: 'u1', sub: 'u1', role: 'MEMBER', email: 'u1@k.t', name: 'u1', blacklisted: false, revoked: false, authorities: [],
};
const agent: KodaPrincipal = {
  actorType: 'agent', id: 'a1', sub: 'a1', slug: 'bot', status: 'ACTIVE', agentRoles: [], capabilities: [],
  name: 'bot', blacklisted: false, revoked: false, authorities: [],
};
const ctx: ProjectContext = { project: { id: 'p1', slug: 'koda' } };

function setup() {
  const service = {
    state: vi.fn().mockResolvedValue({ watching: false, count: 0 }),
    watch: vi.fn().mockResolvedValue({ watching: true, count: 1 }),
    unwatch: vi.fn().mockResolvedValue({ watching: false, count: 0 }),
  };
  return { service, controller: new TicketWatchController(service as never) };
}

describe('TicketWatchController (S4a §3)', () => {
  it('lets any project member (even a VIEWER) watch, scoped to the guard-resolved project', async () => {
    const { controller, service } = setup();
    await controller.watch('KODA-1', ctx, user);
    expect(service.watch).toHaveBeenCalledWith('p1', 'KODA-1', 'u1');
    await controller.unwatch('KODA-1', ctx, user);
    expect(service.unwatch).toHaveBeenCalledWith('p1', 'KODA-1', 'u1');
    await controller.state('KODA-1', ctx, user);
    expect(service.state).toHaveBeenCalledWith('p1', 'KODA-1', 'u1');
  });

  it('refuses agents (403)', async () => {
    const { controller } = setup();
    await expect(controller.watch('KODA-1', ctx, agent)).rejects.toBeInstanceOf(ForbiddenAppException);
    await expect(controller.state('KODA-1', ctx, agent)).rejects.toBeInstanceOf(ForbiddenAppException);
  });
});

// Permissions P1 (US-005): the watch routes declare their keys, and both guards sit at the class
// level so the membership guard resolves `request.projectContext` before the key check.
describe('TicketWatchController permission metadata (US-005)', () => {
  it.each([
    ['state', 'ticket.watch.read'],
    ['watch', 'ticket.watch.set'],
    ['unwatch', 'ticket.watch.unset'],
  ] as const)('%s declares @Requires(%s)', (handler, key) => {
    const fn = TicketWatchController.prototype[handler] as unknown as object;
    expect(Reflect.getMetadata(REQUIRES_METADATA, fn)).toEqual({ keys: [key], mode: 'all', enforcedBy: 'guard' });
    expect(Reflect.getMetadata(PERMISSION_KEY, fn)).toBeUndefined();
  });

  it('runs ProjectMembershipGuard before RequiresGuard at the class level', () => {
    const guards = (Reflect.getMetadata('__guards__', TicketWatchController) ?? []) as unknown[];
    expect(guards.map((guard) => (guard as { name?: string }).name)).toEqual([
      'ProjectMembershipGuard',
      'RequiresGuard',
    ]);
    for (const handler of ['state', 'watch', 'unwatch'] as const) {
      const fn = TicketWatchController.prototype[handler] as unknown as object;
      // A method-level membership guard would run after the class-level key check.
      expect(Reflect.getMetadata('__guards__', fn)).toBeUndefined();
    }
  });
});

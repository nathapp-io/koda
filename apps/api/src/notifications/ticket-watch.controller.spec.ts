import { ForbiddenAppException } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import type { ProjectContext } from '../projects/project-context';
import { TicketWatchController } from './ticket-watch.controller';

const user: KodaPrincipal = {
  actorType: 'user', id: 'u1', sub: 'u1', role: 'MEMBER', email: 'u1@k.t', name: 'u1', blacklisted: false, revoked: false, authorities: [],
};
const agent: KodaPrincipal = {
  actorType: 'agent', id: 'a1', sub: 'a1', slug: 'bot', status: 'ACTIVE', agentRoles: [], capabilities: [],
  name: 'bot', blacklisted: false, revoked: false, authorities: [],
};
const ctx: ProjectContext = { project: { id: 'p1', slug: 'koda' }, role: 'VIEWER' };

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

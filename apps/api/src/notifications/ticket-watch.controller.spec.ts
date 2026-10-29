import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { ApprovalRouteGate } from '../approvals/route/approval-route-gate';
import { APPROVAL_GATED_METADATA } from '../approvals/route/approval-gated.decorator';
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
  const routeGate = { run: vi.fn().mockResolvedValue({ status: 'executed', result: { watching: true, count: 1 } }) };
  const service = {
    state: vi.fn().mockResolvedValue({ watching: false, count: 0 }),
    watch: vi.fn().mockResolvedValue({ watching: true, count: 1 }),
    unwatch: vi.fn().mockResolvedValue({ watching: false, count: 0 }),
  };
  return { service, routeGate, controller: new TicketWatchController(service as never, routeGate as unknown as ApprovalRouteGate) };
}

describe('TicketWatchController (S4a §3)', () => {
  it('lets any project member (even a VIEWER) watch, scoped to the guard-resolved project', async () => {
    const { controller, service, routeGate } = setup();
    await controller.watch('KODA-1', ctx, user);
    expect(routeGate.run).toHaveBeenCalledWith({
      key: 'ticket.watch.set', variant: 'rest:ticket-watch.set', projectId: 'p1', input: { projectId: 'p1', ref: 'KODA-1' },
    });
    expect(service.watch).not.toHaveBeenCalled();
    routeGate.run.mockClear();
    routeGate.run.mockResolvedValue({ status: 'executed', result: { watching: false, count: 0 } });
    await controller.unwatch('KODA-1', ctx, user);
    expect(routeGate.run).toHaveBeenCalledWith({
      key: 'ticket.watch.unset', variant: 'rest:ticket-watch.unset', projectId: 'p1', input: { projectId: 'p1', ref: 'KODA-1' },
    });
    expect(service.unwatch).not.toHaveBeenCalled();
    await controller.state('KODA-1', ctx, user);
    expect(service.state).toHaveBeenCalledWith('p1', 'KODA-1', 'u1');
  });

  it('refuses agents (403)', async () => {
    const { controller, routeGate } = setup();
    await expect(controller.watch('KODA-1', ctx, agent)).rejects.toBeInstanceOf(ForbiddenAppException);
    await expect(controller.state('KODA-1', ctx, agent)).rejects.toBeInstanceOf(ForbiddenAppException);
    expect(routeGate.run).not.toHaveBeenCalled();
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

  it('marks both write handlers as approval-gated', () => {
    for (const handler of ['watch', 'unwatch'] as const) {
      expect(Reflect.getMetadata(APPROVAL_GATED_METADATA, TicketWatchController.prototype[handler])).toBe(true);
    }
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

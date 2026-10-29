import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import type { TicketWatchService } from './ticket-watch.service';
import { TicketWatchRouteCommands, TICKET_WATCH_ROUTE_VARIANTS } from './ticket-watch-route.commands';

describe('TicketWatchRouteCommands', () => {
  it('registers set and unset route commands after module init', () => {
    const registry = new ApprovalCommandRegistry();
    const service = { watch: vi.fn(), unwatch: vi.fn() };
    const loader = { forContext: vi.fn() };
    new TicketWatchRouteCommands(registry, service as unknown as TicketWatchService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    expect(registry.get('ticket.watch.set', TICKET_WATCH_ROUTE_VARIANTS.set)).toBeDefined();
    expect(registry.get('ticket.watch.unset', TICKET_WATCH_ROUTE_VARIANTS.unset)).toBeDefined();
  });

  it('executes watch with the reloaded user id and parsed project input', async () => {
    const registry = new ApprovalCommandRegistry();
    const user = { actorType: 'user', id: 'u1' };
    const loader = { forContext: vi.fn().mockResolvedValue(user) };
    const service = { watch: vi.fn().mockResolvedValue({ watching: true }), unwatch: vi.fn() };
    new TicketWatchRouteCommands(registry, service as unknown as TicketWatchService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    const command = registry.get('ticket.watch.set', TICKET_WATCH_ROUTE_VARIANTS.set);
    if (!command) throw new Error('Missing watch command');
    const input = command.parse({ projectId: 'p1', ref: 'AL-1' });
    await command.execute(input);
    expect(service.watch).toHaveBeenCalledExactlyOnceWith('p1', 'AL-1', 'u1');
  });

  it('refuses an agent in the run callback without calling watch', async () => {
    const registry = new ApprovalCommandRegistry();
    const agent = { actorType: 'agent', id: 'a1' };
    const loader = { forContext: vi.fn().mockResolvedValue(agent) };
    const service = { watch: vi.fn(), unwatch: vi.fn() };
    new TicketWatchRouteCommands(registry, service as unknown as TicketWatchService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    const command = registry.get('ticket.watch.set', TICKET_WATCH_ROUTE_VARIANTS.set);
    if (!command) throw new Error('Missing watch command');
    await expect(command.execute(command.parse({ projectId: 'p1', ref: 'AL-1' }))).rejects.toMatchObject({
      name: 'ForbiddenAppException', response: { prefix: 'notifications' },
    });
    expect(service.watch).not.toHaveBeenCalled();
  });
});

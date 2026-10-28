import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import type { TicketLinksService } from './ticket-links.service';
import { TicketLinkRouteCommands, TICKET_LINK_ROUTE_VARIANTS } from './ticket-link-route.commands';

describe('TicketLinkRouteCommands', () => {
  it('AC-10/11/12: registers, parses and executes rest:ticket-links.remove', async () => {
    const registry = new ApprovalCommandRegistry();
    const principal = { id: 'a1' };
    const loader = { forContext: vi.fn().mockResolvedValue(principal) };
    const service = { remove: vi.fn().mockResolvedValue(undefined) };
    new TicketLinkRouteCommands(registry, service as unknown as TicketLinksService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    expect(TICKET_LINK_ROUTE_VARIANTS.remove).toBe('rest:ticket-links.remove');
    const command = registry.get('ticket.link.remove', 'rest:ticket-links.remove');
    if (!command) throw new Error('Missing command');
    const input = {"slug": "alpha", "ref": "AL-1", "linkId": "k1"};
    expect(command.parse({ ...input, ignored: true })).toEqual(input);
    const result = await command.execute(command.parse(input));
    expect(service.remove).toHaveBeenCalledExactlyOnceWith('alpha', 'AL-1', 'k1', principal);
    expect(loader.forContext).toHaveBeenCalledOnce();
    expect(result).toBeNull();
    expect(command.toResult).toBeUndefined();
    for (const field of Object.keys(input)) {
      const bad = { ...input } as Record<string, unknown>;
      delete bad[field];
      try { command.parse(bad); throw new Error('accepted invalid input'); }
      catch (error) { expect(error).toBeInstanceOf(ValidationAppException); expect(error).toMatchObject({ response: { prefix: 'approvals.invalidInput' } }); }
    }
  });
});

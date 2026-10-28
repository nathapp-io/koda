import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import type { TicketsService } from './tickets.service';
import { TicketRouteCommands, TICKET_ROUTE_VARIANTS } from './ticket-route.commands';

describe('TicketRouteCommands', () => {
  it('AC-10/11/12: registers, parses and executes rest:tickets.delete', async () => {
    const registry = new ApprovalCommandRegistry();
    const principal = { id: 'a1' };
    const loader = { forContext: vi.fn().mockResolvedValue(principal) };
    const service = { softDelete: vi.fn().mockResolvedValue({ ref: 'AL-1' }) };
    new TicketRouteCommands(registry, service as unknown as TicketsService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    expect(TICKET_ROUTE_VARIANTS.delete).toBe('rest:tickets.delete');
    const command = registry.get('ticket.delete', 'rest:tickets.delete');
    if (!command) throw new Error('Missing command');
    const input = {"slug": "alpha", "ref": "AL-1"};
    expect(command.parse({ ...input, ignored: true })).toEqual(input);
    const result = await command.execute(command.parse(input));
    expect(service.softDelete).toHaveBeenCalledExactlyOnceWith('alpha', 'AL-1', principal);
    expect(loader.forContext).toHaveBeenCalledOnce();
    expect(result).toEqual({ ref: 'AL-1' });
    expect(command.toResult?.(result)).toEqual(result);
    for (const field of Object.keys(input)) {
      const bad = { ...input } as Record<string, unknown>;
      delete bad[field];
      try { command.parse(bad); throw new Error('accepted invalid input'); }
      catch (error) { expect(error).toBeInstanceOf(ValidationAppException); expect(error).toMatchObject({ response: { prefix: 'approvals.invalidInput' } }); }
    }
  });
});
